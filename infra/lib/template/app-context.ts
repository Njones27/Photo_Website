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

// Adapted for Photo from aws-samples/aws-cdk-project-template-for-devops (lib/template/app-context.ts):
// `process.env` instead of the env-var package, strict TypeScript, optional `appProps` so tests can inject
// context, and `contextArgs` that skip keys a config file does not have (stage-only keys on the account config).

import * as fs from 'fs';
import * as cdk from 'aws-cdk-lib';

import { AppConfig, StackConfig } from './app-config';
import { StackCommonProps } from './stack/base/base-stack';


export class AppContextError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AppContextError';
    }
}

export enum ProjectPrefixType {
    NameStage,
    NameHyphenStage,
    Name
}

export interface AppContextProps {
    /** Context key or environment variable that holds the config file path, e.g. `APP_CONFIG`. */
    appConfigFileKey: string;
    /** Dotted config keys that may be overridden with `-c Stack.Web.DistPath=...`. */
    contextArgs?: string[];
    projectPrefixType?: ProjectPrefixType;
    /** Passed to `new cdk.App()`. Tests use it to inject context instead of the CLI. */
    appProps?: cdk.AppProps;
}

export class AppContext {
    public readonly cdkApp: cdk.App;
    public readonly appConfig: AppConfig;
    public readonly stackCommonProps: StackCommonProps;

    private readonly appContextProps: AppContextProps;

    constructor(props: AppContextProps) {
        this.cdkApp = new cdk.App(props.appProps);
        this.appContextProps = props;

        let appConfigFile: string;
        try {
            appConfigFile = this.findAppConfigFile(props.appConfigFileKey);
            this.appConfig = this.loadAppConfigFile(appConfigFile, props.contextArgs);
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            console.error(`==> CDK App-Config File could not be loaded (${reason}).
            Set up your environment variable (Usage: export ${props.appConfigFileKey}=config/app-config-xxx.json)
            or append an inline argument (Usage: cdk list --context ${props.appConfigFileKey}=config/app-config-xxx.json)`);
            throw new AppContextError(`Fail to load App-Config json file: ${reason}`);
        }

        this.stackCommonProps = this.createStackCommonProps(appConfigFile);
    }

    public ready(): boolean {
        return this.stackCommonProps ? true : false;
    }

    private createStackCommonProps(appConfigFile: string): StackCommonProps {
        const stackProps: StackCommonProps = {
            projectPrefix: this.getProjectPrefix(this.appConfig.Project.Name, this.appConfig.Project.Stage),
            appConfig: this.appConfig,
            appConfigPath: appConfigFile,
            env: {
                account: this.appConfig.Project.Account,
                region: this.appConfig.Project.Region
            },
            variables: {}
        };

        return stackProps;
    }

    private findAppConfigFile(appConfigKey: string): string {
        let fromType = 'InLine-Argument';
        let configFilePath: unknown = this.cdkApp.node.tryGetContext(appConfigKey);

        if (configFilePath === undefined) {
            configFilePath = process.env[appConfigKey];
            fromType = 'Environment-Variable';
        }

        if (typeof configFilePath !== 'string' || configFilePath.length === 0) {
            throw new Error(`${appConfigKey} is not set`);
        }

        console.info(`==> CDK App-Config File is ${configFilePath}, which is from ${fromType}.`);
        return configFilePath;
    }

    private getProjectPrefix(projectName: string, projectStage: string): string {
        let prefix = `${projectName}${projectStage}`;

        if (this.appContextProps.projectPrefixType === ProjectPrefixType.NameHyphenStage) {
            prefix = `${projectName}-${projectStage}`;
        } else if (this.appContextProps.projectPrefixType === ProjectPrefixType.Name) {
            prefix = projectName;
        }

        return prefix;
    }

    private loadAppConfigFile(filePath: string, contextArgs?: string[]): AppConfig {
        const appConfig = JSON.parse(fs.readFileSync(filePath).toString()) as AppConfig;

        for (const key of ['Name', 'Stage', 'Account', 'Region'] as const) {
            if (typeof appConfig.Project?.[key] !== 'string' || appConfig.Project[key].length === 0) {
                throw new Error(`Project.${key} is missing in ${filePath}`);
            }
        }
        if (typeof appConfig.Stack !== 'object' || appConfig.Stack === null) {
            throw new Error(`Stack is missing in ${filePath}`);
        }
        appConfig.Project.Profile = appConfig.Project.Profile ?? '';

        const projectPrefix = this.getProjectPrefix(appConfig.Project.Name, appConfig.Project.Stage);

        if (contextArgs !== undefined) {
            this.updateContextArgs(appConfig, contextArgs);
        }

        this.addPrefixIntoStackName(appConfig, projectPrefix);

        return appConfig;
    }

    private updateContextArgs(appConfig: AppConfig, contextArgs: string[]) {
        for (const key of contextArgs) {
            const newValue: unknown = this.cdkApp.node.tryGetContext(key);
            if (newValue === undefined) continue;

            const jsonKeys = key.split('.');
            const lastKey = jsonKeys.pop();
            let parent: unknown = appConfig;
            for (const pointer of jsonKeys) {
                parent = isRecord(parent) ? parent[pointer] : undefined;
            }

            if (lastKey === undefined || !isRecord(parent)) {
                console.info(`[INFO] updateContextArgs: ${key} is not part of this App-Config file, ignored.`);
                continue;
            }

            const oldValue = parent[lastKey];
            parent[lastKey] = newValue;
            console.info(`[INFO] updateContextArgs: Updated ${key} = ${String(oldValue)}-->${String(newValue)}`);
        }
    }

    private addPrefixIntoStackName(appConfig: AppConfig, projectPrefix: string) {
        for (const key in appConfig.Stack) {
            const stackConfig: StackConfig = appConfig.Stack[key];
            const stackOriginalName = stackConfig.Name;
            stackConfig.ShortStackName = stackOriginalName;
            stackConfig.Name = `${projectPrefix}-${stackOriginalName}`;
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
