"""Build the prototype photo set from Nathan's picker marks (content/picks.json).

Story photos   -> site/p/<id>.jpg      one file each, 2400px, covers 3200px (walls, openers, viewer)
Archive-only   -> site/k/<n>.jpg       packed four to a file in 1200px cells; the page cuts them out on demand
Every photo    -> site/t/<album>-<n>.jpg  thumbnail sheets, whole photo fitted in 320px cells, 8 across
Data           -> site/portfolio.js    window.PORTFOLIO = {albums, photos, packs, sheets, stories}

The artifact host allows 511 files per page, so ~940 photos can't each be their own file; packing keeps it under.
Run: python3 scripts/build_site_set.py
"""
import hashlib, os, re, io, json, base64, shutil
from multiprocessing import Pool
from PIL import Image, ImageOps
from build_prototype_assets import exif_of, palette, ALBUMS as OLD_ALBUMS, PICKS as OLD_PICKS, SRC

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "site")
PICKS = json.load(open(os.path.join(ROOT, "content", "picks.json")))
# photo titles (content/titles.json, keyed by photo id) override the old hand-written captions
TPATH = os.path.join(ROOT, "content", "titles.json")
TITLES = json.load(open(TPATH)) if os.path.exists(TPATH) else {}
STORY_EDGE, PACK_CELL, THUMB, TCOLS, TPER = 2400, 1200, 320, 8, 48
# covers fill the whole screen (the hero is one), so they get more pixels: sharp on a 1440 or 1920 wide retina display
COVER_EDGE, COVER_Q, STORY_Q = 3200, 84, 80

# Album details. Places left blank where the folder doesn't say (listed as open questions in tasks/todo.md).
NEW = {
 "america-250-washington-dc": dict(title="America 250", place="Washington, D.C.", venue="Independence Day flyovers", genre="aviation", season="July 2026"),
 "bella-jones-senior-pics": dict(title="Bella, Class of 2026", place="", venue="Senior portraits", genre="people", season="Spring 2026"),
 "christmas-2025": dict(title="Christmas 2025", place="", venue="", genre="people", season="December 2025"),
 "huntsville-ducks-spring-2026": dict(title="Huntsville Ducks", place="Huntsville", venue="", genre="wildlife", season="Spring 2026"),
 "ic-flag-football-10-21-2025": dict(title="Innovation Center Flag Football, October 21", place="", venue="", genre="sports", season="October 2025"),
 "ic-flag-football-10-8-2025": dict(title="Innovation Center Flag Football, October 8", place="", venue="", genre="sports", season="October 2025"),
 "indianapolis-christmas-2024": dict(title="Indianapolis at Christmas", place="Indianapolis, Indiana", venue="", genre="night", season="December 2024"),
 "jessica-jones-senior-prom": dict(title="Jessica's Senior Prom", place="", venue="", genre="people", season="May 2025"),
 "july-4th-2025-seattle-wa": dict(title="Fourth of July, 2025", place="Seattle, Washington", venue="", genre="night", season="July 2025"),
 "kentucky-kernel-ben-carson-uk-11-20-2024": dict(title="Ben Carson at UK", place="Lexington, Kentucky", venue="For the Kentucky Kernel", genre="news", season="November 2024"),
 "kentucky-kernel-chinese-new-year-feb-6-2025": dict(title="Chinese New Year", place="Lexington, Kentucky", venue="For the Kentucky Kernel", genre="news", season="February 2025"),
 "kentucky-kernel-lunar-new-year-jan-31-2025": dict(title="Lunar New Year", place="Lexington, Kentucky", venue="For the Kentucky Kernel", genre="news", season="January 2025"),
 "kentucky-kernel-pumpkins-and-power-tools-10-23-2024": dict(title="Pumpkins and Power Tools", place="Lexington, Kentucky", venue="For the Kentucky Kernel", genre="news", season="October 2024"),
 "logan-jones-2010-dodge-ram-1500": dict(title="Logan's 2010 Ram 1500", place="", venue="", genre="automotive", season="November 2025"),
 "rcshs-homecoming-2024": dict(title="RCSHS Homecoming", place="", venue="", genre="people", season="October 2024"),
 "rcshs-homecoming-football-game-2024": dict(title="RCSHS Homecoming Game", place="", venue="", genre="sports", season="October 2024"),
 "seattle-wa-summer-2025": dict(title="Seattle, Summer 2025", place="Seattle, Washington", venue="", genre="travel", season="Summer 2025"),
 "senior-photos": dict(title="Senior Portraits", place="", venue="", genre="people", season="Fall 2024"),
 "uk-engineering-takes-flight-2024": dict(title="Engineering Takes Flight, 2024", place="Lexington, Kentucky", venue="University of Kentucky", genre="aviation", season="September 2024"),
 "uk-engineering-headshots-2025": dict(title="Engineering Headshots", place="Lexington, Kentucky", venue="University of Kentucky", genre="people", season="September 2025"),
 "uk-engineering-takes-flight-2026": dict(title="Engineering Takes Flight, 2026", place="Lexington, Kentucky", venue="University of Kentucky", genre="aviation", season="October 2026"),
}
DIRS = {k: v["dir"] for k, v in OLD_ALBUMS.items()}
DIRS.update({
 "america-250-washington-dc": "America 250 - Washington DC", "bella-jones-senior-pics": "Bella Jones - Senior Pics",
 "christmas-2025": "Christmas 2025", "huntsville-ducks-spring-2026": "Huntsville Ducks - Spring 2026",
 "ic-flag-football-10-21-2025": "IC Flag Football 10-21-2025", "ic-flag-football-10-8-2025": "IC Flag Football 10-8-2025",
 "indianapolis-christmas-2024": "Indianapolis Christmas 2024", "jessica-jones-senior-prom": "Jessica Jones Senior Prom",
 "july-4th-2025-seattle-wa": "July 4th, 2025 - Seattle, WA",
 "kentucky-kernel-ben-carson-uk-11-20-2024": "Kentucky Kernel/Ben Carson @ UK 11-20-2024",
 "kentucky-kernel-chinese-new-year-feb-6-2025": "Kentucky Kernel/Chinese New Year - Feb. 6, 2025",
 "kentucky-kernel-lunar-new-year-jan-31-2025": "Kentucky Kernel/Lunar New Year - Jan. 31, 2025",
 "kentucky-kernel-pumpkins-and-power-tools-10-23-2024": "Kentucky Kernel/Pumpkins and Power Tools - 10-23-2024",
 "logan-jones-2010-dodge-ram-1500": "Logan Jones - 2010 Dodge Ram 1500", "rcshs-homecoming-2024": "RCSHS Homecoming 2024",
 "rcshs-homecoming-football-game-2024": "RCSHS Homecoming Football Game 2024", "seattle-wa-summer-2025": "Seattle, WA - Summer 2025",
 "senior-photos": "Senior Photos", "uk-engineering-takes-flight-2024": "UK Engineering Takes Flight 2024",
 "uk-engineering-takes-flight-2026": "UK Engineering Takes Flight 2026",
 "uk-engineering-headshots-2025": "UK Engineering Headshots - Fall 2025",
})
# keep the hand-written captions and ids from the first prototype, pinned to file names
# (content/legacy_ids.json; never look them up by position, since adding a photo to a folder shifts positions)
OLD = {(alb, f): tuple(v) for alb, m in json.load(open(os.path.join(ROOT, "content", "legacy_ids.json"))).items() for f, v in m.items()}

def pid_for(alb, f):
    if (alb, f) in OLD: return OLD[(alb, f)][0]
    return f"{alb}-" + re.sub(r"[^a-z0-9]+", "-", os.path.splitext(f)[0].lower()).strip("-")

def load(alb, f, edge):
    im = Image.open(os.path.join(SRC, DIRS[alb], f)); ex = exif_of(im)
    im.draft("RGB", (edge, edge))
    im = ImageOps.exif_transpose(im).convert("RGB")
    return im, ex

def photo_job(job):
    """Story photo: its own file. Archive-only: returns a 1200px copy for packing. Always: palette, exif, thumb."""
    alb, f, story, cover = job
    edge = COVER_EDGE if cover else STORY_EDGE if story else PACK_CELL
    im, ex = load(alb, f, edge)
    pid = pid_for(alb, f)
    src0 = Image.open(os.path.join(SRC, DIRS[alb], f)); w, h = src0.size
    if src0.getexif().get(0x0112, 1) in (5, 6, 7, 8): w, h = h, w   # rotated by EXIF
    rec = dict(id=pid, album=alb, file=f, caption=TITLES.get(pid) or OLD.get((alb, f), (None, ""))[1], w=w, h=h, exif=ex, color=palette(im), story=story)
    big = im.copy(); big.thumbnail((edge,) * 2, Image.LANCZOS)
    if story:
        big.save(os.path.join(OUT, "p", f"{pid}.jpg"), quality=COVER_Q if cover else STORY_Q, optimize=True, progressive=True)
        # a fingerprint of the file in the address, so browsers fetch a new copy whenever the photo changes
        rec["src"] = f"p/{pid}.jpg?v=" + hashlib.md5(open(os.path.join(OUT, "p", f"{pid}.jpg"), "rb").read()).hexdigest()[:8]
        t = im.copy(); t.thumbnail((24, 24)); buf = io.BytesIO(); t.save(buf, "JPEG", quality=50)
        rec["lqip"] = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    th = im.copy(); th.thumbnail((THUMB, THUMB), Image.LANCZOS)   # whole photo, never cropped
    tb = io.BytesIO(); th.save(tb, "PNG"); bb = None
    if not story: bb = io.BytesIO(); big.save(bb, "JPEG", quality=95)
    return rec, tb.getvalue(), (bb.getvalue() if bb else None)

def main():
    for d in ("p", "k", "t"):
        shutil.rmtree(os.path.join(OUT, d), ignore_errors=True); os.makedirs(os.path.join(OUT, d))
    jobs = []
    for alb, m in PICKS.items():
        files = sorted(f for f in os.listdir(os.path.join(SRC, DIRS[alb])) if f.lower().endswith((".jpg", ".jpeg")))
        st, ar = set(m.get("story", [])), set(m.get("archive", []))
        cover = m.get("cover") or (sorted(st)[0] if st else None)   # same rule as the stories block below
        jobs += [(alb, f, f in st, f in st and f == cover) for f in files if f in st or f in ar]
    with Pool(8) as pool: res = pool.map(photo_job, jobs, chunksize=4)
    photos = [r[0] for r in res]

    # pack archive-only photos four to a 2x2 sheet of 1200px cells
    packs, buf = [], []
    def flush():
        if not buf: return
        n = len(packs); cols = min(len(buf), 2); rows = -(-len(buf) // 2)
        sheet = Image.new("RGB", (cols * PACK_CELL, rows * PACK_CELL), (0, 0, 0))
        for i, (rec, png) in enumerate(buf):
            im = Image.open(io.BytesIO(png)); x = (i % 2) * PACK_CELL; y = (i // 2) * PACK_CELL
            sheet.paste(im, (x, y)); rec["pack"] = [n, x, y, im.width, im.height]
        sheet.save(os.path.join(OUT, "k", f"{n}.jpg"), quality=74, optimize=True, progressive=True)
        packs.append(f"k/{n}.jpg"); buf.clear()
    for rec, _, png in res:
        if png: buf.append((rec, png))
        if len(buf) == 4: flush()
    flush()

    # thumbnail sheets, per album: each photo centred in its cell, rect recorded so the page can cut it out uncropped
    sheets, by_album = [], {}
    for rec, tpng, _ in res: by_album.setdefault(rec["album"], []).append((rec, tpng))
    for alb, items in by_album.items():
        for k in range(0, len(items), TPER):
            chunk = items[k:k + TPER]; cols = min(len(chunk), TCOLS); rows = -(-len(chunk) // TCOLS)
            sh = Image.new("RGB", (cols * THUMB, rows * THUMB))
            for i, (rec, tpng) in enumerate(chunk):
                t = Image.open(io.BytesIO(tpng)); x = (i % TCOLS) * THUMB + (THUMB - t.width) // 2; y = (i // TCOLS) * THUMB + (THUMB - t.height) // 2
                sh.paste(t, (x, y)); rec["thumb"] = [len(sheets), x, y, t.width, t.height]
            name = f"t/{alb}-{k // TPER}.jpg"; sh.save(os.path.join(OUT, name), quality=72, optimize=True, progressive=True)
            sheets.append(dict(src=name, w=sh.width, h=sh.height))

    albums = {}
    for alb in PICKS:
        meta = dict(NEW.get(alb) or {k: v for k, v in OLD_ALBUMS[alb].items() if k != "dir"})
        meta.pop("ll", None); albums[alb] = meta
    byfile = {(p["album"], p["file"]): p["id"] for p in photos}
    stories = {}
    for alb, m in PICKS.items():
        st = [byfile[(alb, f)] for f in sorted(m.get("story", [])) if (alb, f) in byfile]
        if not st: continue
        cover = byfile.get((alb, m.get("cover"))) if m.get("cover") else None
        stories[alb] = dict(cover=cover or st[0], photos=[x for x in st if x != (cover or st[0])], coverPicked=bool(cover))
    data = dict(albums=albums, photos=photos, packs=packs, sheets=sheets, stories=stories, thumbCell=THUMB)
    open(os.path.join(OUT, "portfolio.js"), "w").write("window.PORTFOLIO = " + json.dumps(data, separators=(",", ":")) + ";\n")
    print(f"{len(photos)} photos: {sum(p['story'] for p in photos)} story files, {len(packs)} packs, {len(sheets)} thumb sheets, {len(stories)} stories")

if __name__ == "__main__": main()
