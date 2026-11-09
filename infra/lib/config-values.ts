// Typed, validated reads of `Stack.<Name>` config values. A typo in a config file should fail synth with a clear
// message, not silently drop a guardrail such as reserved concurrency or a throttle.

import { StackConfig } from './template/app-config';

function fail(config: StackConfig, key: string, expected: string): never {
    throw new Error(`[config] ${config.ShortStackName ?? config.Name}.${key} must be ${expected} (got ${JSON.stringify(config[key])})`);
}

export function configString(config: StackConfig, key: string, fallback?: string): string {
    const value = config[key] ?? fallback;
    if (typeof value !== 'string') fail(config, key, 'a string');
    return value;
}

export function configBoolean(config: StackConfig, key: string): boolean {
    const value = config[key];
    if (typeof value !== 'boolean') fail(config, key, 'true or false');
    return value;
}

export function configPositiveInt(config: StackConfig, key: string): number {
    const value = config[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) fail(config, key, 'a positive integer');
    return value;
}

export function configNumberList(config: StackConfig, key: string): number[] {
    const value = config[key];
    if (!Array.isArray(value) || !value.every((v): v is number => typeof v === 'number' && v > 0)) {
        fail(config, key, 'a list of positive numbers');
    }
    return value;
}

/** A non-negative integer that may be left out; missing means `fallback`. */
export function configOptionalNonNegativeInt(config: StackConfig, key: string, fallback = 0): number {
    const value = config[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(config, key, 'a non-negative integer (or left out)');
    return value;
}
