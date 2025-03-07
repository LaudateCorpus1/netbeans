/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
'use strict';

import { commands, debug, tests, workspace, CancellationToken, TestController, TestItem, TestRunProfileKind, TestRunRequest, Uri, TestRun, TestMessage, Location, Position } from "vscode";
import * as path from 'path';
import { asRange, TestSuite } from "./protocol";
import { LanguageClient } from "vscode-languageclient";

export class NbTestAdapter {

    private readonly testController: TestController;
	private disposables: { dispose(): void }[] = [];
    private currentRun: TestRun | undefined;
    private itemsToRun: Set<TestItem> | undefined;

    constructor(client: Promise<LanguageClient>) {
        this.testController = tests.createTestController('apacheNetBeansController', 'Apache NetBeans');
        const runHandler = (request: TestRunRequest, cancellation: CancellationToken) => this.run(request, cancellation);
        this.testController.createRunProfile('Run Tests', TestRunProfileKind.Run, runHandler);
        this.testController.createRunProfile('Debug Tests', TestRunProfileKind.Debug, runHandler);
        this.disposables.push(this.testController);
        client.then(async () => await this.load());
    }

    async load(): Promise<void> {
        for (let workspaceFolder of workspace.workspaceFolders || []) {
            const loadedTests: any = await commands.executeCommand('java.load.workspace.tests', workspaceFolder.uri.toString());
            if (loadedTests) {
                loadedTests.forEach((suite: TestSuite) => {
                    this.updateTests(suite);
                });
            }
        }
    }

    async run(request: TestRunRequest, cancellation: CancellationToken): Promise<void> {
        cancellation.onCancellationRequested(() => this.cancel());
        this.currentRun = this.testController.createTestRun(request);
        this.itemsToRun = new Set();
		if (request.include) {
            const include = [...new Map(request.include.map(item => !item.uri && item.parent?.uri ? [item.parent.id, item.parent] : [item.id, item])).values()];
            for (let item of include) {
                if (item.uri) {
                    this.set(item, 'enqueued');
                    const idx = item.id.indexOf(':');
                    await commands.executeCommand(request.profile?.kind === TestRunProfileKind.Debug ? 'java.debug.single' : 'java.run.single', item.uri.toString(), idx < 0 ? undefined : item.id.slice(idx + 1));
                }
            }
		} else {
            this.testController.items.forEach(item => this.set(item, 'enqueued'));
            for (let workspaceFolder of workspace.workspaceFolders || []) {
                if (!cancellation.isCancellationRequested) {
                    await commands.executeCommand(request.profile?.kind === TestRunProfileKind.Debug ? 'java.debug.test': 'java.run.test', workspaceFolder.uri.toString());
                }
            }
        }
        this.itemsToRun.forEach(item => this.set(item, 'skipped'));
        this.itemsToRun = undefined;
        this.currentRun.end();
        this.currentRun = undefined;
    }

    set(item: TestItem, state: 'enqueued' | 'started' | 'passed' | 'failed' | 'skipped' | 'errored', message?: TestMessage | readonly TestMessage[], noPassDown? : boolean): void {
        if (this.currentRun) {
            switch (state) {
                case 'enqueued':
                    this.itemsToRun?.add(item);
                    this.currentRun.enqueued(item);
                    break;
                case 'started':
                case 'passed':
                case 'skipped':
                    this.itemsToRun?.delete(item);
                    this.currentRun[state](item);
                    break;
                case 'failed':
                case 'errored':
                    this.itemsToRun?.delete(item);
                    this.currentRun[state](item, message || new TestMessage(''));
                    break;
            }
            if (!noPassDown) {
                item.children.forEach(child => this.set(child, state, message, noPassDown));
            }
        }
    }

    cancel(): void {
        debug.stopDebugging();
    }

    dispose(): void {
		this.cancel();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];
	}

    testProgress(suite: TestSuite): void {
        const currentSuite = this.testController.items.get(suite.name);
        switch (suite.state) {
            case 'loaded':
                this.updateTests(suite);
                break;
            case 'started':
                if (currentSuite) {
                    this.set(currentSuite, 'started');
                }
                break;
            case 'completed':
            case 'errored':
                if (suite.tests) {
                    this.updateTests(suite, true);
                    if (currentSuite) {
                        const suiteMessages: TestMessage[] = [];
                        suite.tests?.forEach(test => {
                            if (this.currentRun) {
                                let currentTest = currentSuite.children.get(test.id);
                                if (!currentTest) {
                                    currentSuite.children.forEach(item => {
                                        if (!currentTest && test.id.startsWith(item.id)) {
                                            currentTest = item.children.get(test.id);
                                        }
                                    });
                                }
                                let message: TestMessage | undefined;
                                if (test.stackTrace) {
                                    message = new TestMessage(test.stackTrace.join('\n'));
                                    if (currentTest) {
                                        const testUri = currentTest.uri || currentTest.parent?.uri;
                                        if (testUri) {
                                            const fileName = path.basename(testUri.path);
                                            const line = test.stackTrace.map(frame => {
                                                const info = frame.match(/^\s*at[^\(]*\((\S*):(\d*)\)$/);
                                                if (info && info.length >= 3 && info[1] === fileName) {
                                                    return parseInt(info[2]);
                                                }
                                                return null;
                                            }).find(l => l);
                                            const pos = line ? new Position(line - 1, 0) : currentTest.range?.start;
                                            if (pos) {
                                                message.location = new Location(testUri, pos);
                                            }
                                        }
                                    } else {
                                        message.location = new Location(currentSuite.uri!, currentSuite.range!.start);
                                    }
                                }
                                if (currentTest && test.state !== 'loaded') {
                                    this.set(currentTest, test.state, message, true);
                                } else if (test.state !== 'passed' && message) {
                                    suiteMessages.push(message);
                                }
                            }
                        });
                        if (suiteMessages.length > 0) {
                            this.set(currentSuite, 'errored', suiteMessages, true);
                            currentSuite.children.forEach(item => this.set(item, 'skipped'));
                        }
                    }
                }
                break;
        }
    }

    updateTests(suite: TestSuite, testExecution?: boolean): void {
        let currentSuite = this.testController.items.get(suite.name);
        const suiteUri = suite.file ? Uri.parse(suite.file) : undefined;
        if (!currentSuite || suiteUri && currentSuite.uri?.toString() !== suiteUri.toString()) {
            currentSuite = this.testController.createTestItem(suite.name, suite.name, suiteUri);
            this.testController.items.add(currentSuite);
        }
        const suiteRange = asRange(suite.range);
        if (!testExecution && suiteRange && suiteRange !== currentSuite.range) {
            currentSuite.range = suiteRange;
        }
        const children: TestItem[] = []
        const parentTests: Map<TestItem, TestItem[]> = new Map();
        suite.tests?.forEach(test => {
            let currentTest = currentSuite?.children.get(test.id);
            const testUri = test.file ? Uri.parse(test.file) : undefined;
            if (currentTest) {
                if (currentTest.uri?.toString() !== testUri?.toString()) {
                    currentTest = this.testController.createTestItem(test.id, test.name, testUri);
                    currentSuite?.children.add(currentTest);
                }
                const testRange = asRange(test.range);
                if (!testExecution && testRange && testRange !== currentTest.range) {
                    currentTest.range = testRange;
                }
                children.push(currentTest);
            } else {
                if (testExecution) {
                    const parents: TestItem[] = [];
                    currentSuite?.children.forEach(item => {
                        if (test.id.startsWith(item.id)) {
                            parents.push(item);
                        }
                    });
                    if (parents.length === 1) {
                        let arr = parentTests.get(parents[0]);
                        if (!arr) {
                            parentTests.set(parents[0], arr = []);
                            children.push(parents[0]);
                        }
                        let label = test.name;
                        if (label.startsWith(parents[0].label)) {
                            label = label.slice(parents[0].label.length).trim();
                        }
                        arr.push(this.testController.createTestItem(test.id, label));
                    }
                } else {
                    currentTest = this.testController.createTestItem(test.id, test.name, testUri);
                    currentTest.range = asRange(test.range);
                    children.push(currentTest);
                    currentSuite?.children.add(currentTest);
                }
            }
        });
        if (testExecution) {
            parentTests.forEach((val, key) => {
                const item = this.testController.createTestItem(key.id, key.label, key.uri);
                item.range = key.range;
                item.children.replace(val);
                currentSuite?.children.add(item);
            });
        } else {
            currentSuite.children.replace(children);
        }
    }
}
