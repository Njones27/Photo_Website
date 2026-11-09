/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

// Adapted for Photo from aws-samples/aws-cdk-project-template-for-devops (lib/template/app-config.ts):
// typed `Stack` map, optional `Global`, values unknown until a stack narrows them.

export interface ProjectConfig {
    Name: string;
    Stage: string;
    Account: string;
    Region: string;
    Profile: string;
}

export interface StackConfig {
    /** Full stack name after AppContext adds the project prefix, e.g. `Photo-Beta-Web`. */
    Name: string;
    /** The name as written in the config file, e.g. `Web`. Filled in by AppContext. */
    ShortStackName?: string;
    UpdateRegionName?: string;
    [name: string]: unknown;
}

export interface AppConfig {
    Project: ProjectConfig;
    Global?: Record<string, unknown>;
    Stack: Record<string, StackConfig>;
}
