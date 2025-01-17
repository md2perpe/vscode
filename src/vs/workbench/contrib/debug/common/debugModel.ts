/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { URI as uri } from 'vs/base/common/uri';
import * as resources from 'vs/base/common/resources';
import * as lifecycle from 'vs/base/common/lifecycle';
import { Event, Emitter } from 'vs/base/common/event';
import { generateUuid } from 'vs/base/common/uuid';
import { RunOnceScheduler } from 'vs/base/common/async';
import { isString, isUndefinedOrNull } from 'vs/base/common/types';
import { distinct, lastIndex } from 'vs/base/common/arrays';
import { Range, IRange } from 'vs/editor/common/core/range';
import {
	ITreeElement, IExpression, IExpressionContainer, IDebugSession, IStackFrame, IExceptionBreakpoint, IBreakpoint, IFunctionBreakpoint, IDebugModel,
	IThread, IRawModelUpdate, IScope, IRawStoppedDetails, IEnablement, IBreakpointData, IExceptionInfo, IBreakpointsChangeEvent, IBreakpointUpdateData, IBaseBreakpoint, State, IDataBreakpoint
} from 'vs/workbench/contrib/debug/common/debug';
import { Source, UNKNOWN_SOURCE_LABEL } from 'vs/workbench/contrib/debug/common/debugSource';
import { commonSuffixLength } from 'vs/base/common/strings';
import { posix } from 'vs/base/common/path';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { ITextEditor } from 'vs/workbench/common/editor';
import { mixin } from 'vs/base/common/objects';

export class ExpressionContainer implements IExpressionContainer {

	public static readonly allValues = new Map<string, string>();
	// Use chunks to support variable paging #9537
	private static readonly BASE_CHUNK_SIZE = 100;

	public type: string | undefined;
	public valueChanged = false;
	private _value: string = '';
	protected children?: Promise<IExpression[]>;

	constructor(
		protected session: IDebugSession | undefined,
		protected threadId: number | undefined,
		private _reference: number | undefined,
		private id: string,
		public namedVariables: number | undefined = 0,
		public indexedVariables: number | undefined = 0,
		private startOfVariables: number | undefined = 0
	) { }

	get reference(): number | undefined {
		return this._reference;
	}

	set reference(value: number | undefined) {
		this._reference = value;
		this.children = undefined; // invalidate children cache
	}

	getChildren(): Promise<IExpression[]> {
		if (!this.children) {
			this.children = this.doGetChildren();
		}

		return this.children;
	}

	private async doGetChildren(): Promise<IExpression[]> {
		if (!this.hasChildren) {
			return [];
		}

		if (!this.getChildrenInChunks) {
			return this.fetchVariables(undefined, undefined, undefined);
		}

		// Check if object has named variables, fetch them independent from indexed variables #9670
		const children = this.namedVariables ? await this.fetchVariables(undefined, undefined, 'named') : [];

		// Use a dynamic chunk size based on the number of elements #9774
		let chunkSize = ExpressionContainer.BASE_CHUNK_SIZE;
		while (!!this.indexedVariables && this.indexedVariables > chunkSize * ExpressionContainer.BASE_CHUNK_SIZE) {
			chunkSize *= ExpressionContainer.BASE_CHUNK_SIZE;
		}

		if (!!this.indexedVariables && this.indexedVariables > chunkSize) {
			// There are a lot of children, create fake intermediate values that represent chunks #9537
			const numberOfChunks = Math.ceil(this.indexedVariables / chunkSize);
			for (let i = 0; i < numberOfChunks; i++) {
				const start = (this.startOfVariables || 0) + i * chunkSize;
				const count = Math.min(chunkSize, this.indexedVariables - i * chunkSize);
				children.push(new Variable(this.session, this.threadId, this, this.reference, `[${start}..${start + count - 1}]`, '', '', undefined, count, { kind: 'virtual' }, undefined, true, start));
			}

			return children;
		}

		const variables = await this.fetchVariables(this.startOfVariables, this.indexedVariables, 'indexed');
		return children.concat(variables);
	}

	getId(): string {
		return this.id;
	}

	getSession(): IDebugSession | undefined {
		return this.session;
	}

	get value(): string {
		return this._value;
	}

	get hasChildren(): boolean {
		// only variables with reference > 0 have children.
		return !!this.reference && this.reference > 0;
	}

	private async fetchVariables(start: number | undefined, count: number | undefined, filter: 'indexed' | 'named' | undefined): Promise<Variable[]> {
		try {
			const response = await this.session!.variables(this.reference || 0, this.threadId, filter, start, count);
			return response && response.body && response.body.variables
				? distinct(response.body.variables.filter(v => !!v && isString(v.name)), (v: DebugProtocol.Variable) => v.name).map((v: DebugProtocol.Variable) =>
					new Variable(this.session, this.threadId, this, v.variablesReference, v.name, v.evaluateName, v.value, v.namedVariables, v.indexedVariables, v.presentationHint, v.type))
				: [];
		} catch (e) {
			return [new Variable(this.session, this.threadId, this, 0, e.message, e.message, '', 0, 0, { kind: 'virtual' }, undefined, false)];
		}
	}

	// The adapter explicitly sents the children count of an expression only if there are lots of children which should be chunked.
	private get getChildrenInChunks(): boolean {
		return !!this.indexedVariables;
	}

	set value(value: string) {
		this._value = value;
		this.valueChanged = !!ExpressionContainer.allValues.get(this.getId()) &&
			ExpressionContainer.allValues.get(this.getId()) !== Expression.DEFAULT_VALUE && ExpressionContainer.allValues.get(this.getId()) !== value;
		ExpressionContainer.allValues.set(this.getId(), value);
	}

	toString(): string {
		return this.value;
	}

	async evaluateExpression(
		expression: string,
		session: IDebugSession | undefined,
		stackFrame: IStackFrame | undefined,
		context: string): Promise<boolean> {

		if (!session || (!stackFrame && context !== 'repl')) {
			this.value = context === 'repl' ? nls.localize('startDebugFirst', "Please start a debug session to evaluate expressions") : Expression.DEFAULT_VALUE;
			this.reference = 0;
			return false;
		}

		this.session = session;
		try {
			const response = await session.evaluate(expression, stackFrame ? stackFrame.frameId : undefined, context);
			if (response && response.body) {
				this.value = response.body.result || '';
				this.reference = response.body.variablesReference;
				this.namedVariables = response.body.namedVariables;
				this.indexedVariables = response.body.indexedVariables;
				this.type = response.body.type || this.type;
				return true;
			}
			return false;
		} catch (e) {
			this.value = e.message || '';
			this.reference = 0;
			return false;
		}
	}
}

export class Expression extends ExpressionContainer implements IExpression {
	static readonly DEFAULT_VALUE = nls.localize('notAvailable', "not available");

	public available: boolean;

	constructor(public name: string, id = generateUuid()) {
		super(undefined, undefined, 0, id);
		this.available = false;
		// name is not set if the expression is just being added
		// in that case do not set default value to prevent flashing #14499
		if (name) {
			this.value = Expression.DEFAULT_VALUE;
		}
	}

	async evaluate(session: IDebugSession | undefined, stackFrame: IStackFrame | undefined, context: string): Promise<void> {
		this.available = await this.evaluateExpression(this.name, session, stackFrame, context);
	}

	toString(): string {
		return `${this.name}\n${this.value}`;
	}
}

export class Variable extends ExpressionContainer implements IExpression {

	// Used to show the error message coming from the adapter when setting the value #7807
	public errorMessage: string | undefined;

	constructor(
		session: IDebugSession | undefined,
		threadId: number | undefined,
		public parent: IExpressionContainer,
		reference: number | undefined,
		public name: string,
		public evaluateName: string | undefined,
		value: string | undefined,
		namedVariables: number | undefined,
		indexedVariables: number | undefined,
		public presentationHint: DebugProtocol.VariablePresentationHint | undefined,
		public type: string | undefined = undefined,
		public available = true,
		startOfVariables = 0
	) {
		super(session, threadId, reference, `variable:${parent.getId()}:${name}`, namedVariables, indexedVariables, startOfVariables);
		this.value = value || '';
	}

	async setVariable(value: string): Promise<any> {
		if (!this.session) {
			return;
		}

		try {
			const response = await this.session.setVariable((<ExpressionContainer>this.parent).reference, this.name, value);
			if (response && response.body) {
				this.value = response.body.value || '';
				this.type = response.body.type || this.type;
				this.reference = response.body.variablesReference;
				this.namedVariables = response.body.namedVariables;
				this.indexedVariables = response.body.indexedVariables;
			}
		} catch (err) {
			this.errorMessage = err.message;
		}
	}

	toString(): string {
		return `${this.name}: ${this.value}`;
	}
}

export class Scope extends ExpressionContainer implements IScope {

	constructor(
		stackFrame: IStackFrame,
		index: number,
		public name: string,
		reference: number,
		public expensive: boolean,
		namedVariables?: number,
		indexedVariables?: number,
		public range?: IRange
	) {
		super(stackFrame.thread.session, stackFrame.thread.threadId, reference, `scope:${name}:${index}`, namedVariables, indexedVariables);
	}

	toString(): string {
		return this.name;
	}
}

export class StackFrame implements IStackFrame {

	private scopes: Promise<Scope[]> | undefined;

	constructor(
		public thread: IThread,
		public frameId: number,
		public source: Source,
		public name: string,
		public presentationHint: string | undefined,
		public range: IRange,
		private index: number
	) { }

	getId(): string {
		return `stackframe:${this.thread.getId()}:${this.frameId}:${this.index}`;
	}

	getScopes(): Promise<IScope[]> {
		if (!this.scopes) {
			this.scopes = this.thread.session.scopes(this.frameId, this.thread.threadId).then(response => {
				return response && response.body && response.body.scopes ?
					response.body.scopes.map((rs, index) => new Scope(this, index, rs.name, rs.variablesReference, rs.expensive, rs.namedVariables, rs.indexedVariables,
						rs.line && rs.column && rs.endLine && rs.endColumn ? new Range(rs.line, rs.column, rs.endLine, rs.endColumn) : undefined)) : [];
			}, err => []);
		}

		return this.scopes;
	}

	getSpecificSourceName(): string {
		// To reduce flashing of the path name and the way we fetch stack frames
		// We need to compute the source name based on the other frames in the stale call stack
		let callStack = (<Thread>this.thread).getStaleCallStack();
		callStack = callStack.length > 0 ? callStack : this.thread.getCallStack();
		const otherSources = callStack.map(sf => sf.source).filter(s => s !== this.source);
		let suffixLength = 0;
		otherSources.forEach(s => {
			if (s.name === this.source.name) {
				suffixLength = Math.max(suffixLength, commonSuffixLength(this.source.uri.path, s.uri.path));
			}
		});
		if (suffixLength === 0) {
			return this.source.name;
		}

		const from = Math.max(0, this.source.uri.path.lastIndexOf(posix.sep, this.source.uri.path.length - suffixLength - 1));
		return (from > 0 ? '...' : '') + this.source.uri.path.substr(from);
	}

	getMostSpecificScopes(range: IRange): Promise<IScope[]> {
		return this.getScopes().then(scopes => {
			scopes = scopes.filter(s => !s.expensive);
			const haveRangeInfo = scopes.some(s => !!s.range);
			if (!haveRangeInfo) {
				return scopes;
			}

			const scopesContainingRange = scopes.filter(scope => scope.range && Range.containsRange(scope.range, range))
				.sort((first, second) => (first.range!.endLineNumber - first.range!.startLineNumber) - (second.range!.endLineNumber - second.range!.startLineNumber));
			return scopesContainingRange.length ? scopesContainingRange : scopes;
		});
	}

	restart(): Promise<void> {
		return this.thread.session.restartFrame(this.frameId, this.thread.threadId);
	}

	forgetScopes(): void {
		this.scopes = undefined;
	}

	toString(): string {
		const lineNumberToString = typeof this.range.startLineNumber === 'number' ? `:${this.range.startLineNumber}` : '';
		const sourceToString = `${this.source.inMemory ? this.source.name : this.source.uri.fsPath}${lineNumberToString}`;

		return sourceToString === UNKNOWN_SOURCE_LABEL ? this.name : `${this.name} (${sourceToString})`;
	}

	async openInEditor(editorService: IEditorService, preserveFocus?: boolean, sideBySide?: boolean, pinned?: boolean): Promise<ITextEditor | undefined> {
		if (this.source.available) {
			return this.source.openInEditor(editorService, this.range, preserveFocus, sideBySide, pinned);
		}
		return undefined;
	}

	equals(other: IStackFrame): boolean {
		return (this.name === other.name) && (other.thread === this.thread) && (other.source === this.source) && (Range.equalsRange(this.range, other.range));
	}
}

export class Thread implements IThread {
	private callStack: IStackFrame[];
	private staleCallStack: IStackFrame[];
	public stoppedDetails: IRawStoppedDetails | undefined;
	public stopped: boolean;

	constructor(public session: IDebugSession, public name: string, public threadId: number) {
		this.callStack = [];
		this.staleCallStack = [];
		this.stopped = false;
	}

	getId(): string {
		return `thread:${this.session.getId()}:${this.threadId}`;
	}

	clearCallStack(): void {
		if (this.callStack.length) {
			this.staleCallStack = this.callStack;
		}
		this.callStack = [];
	}

	getCallStack(): IStackFrame[] {
		return this.callStack;
	}

	getStaleCallStack(): ReadonlyArray<IStackFrame> {
		return this.staleCallStack;
	}

	get stateLabel(): string {
		if (this.stoppedDetails) {
			return this.stoppedDetails.description ||
				this.stoppedDetails.reason ? nls.localize({ key: 'pausedOn', comment: ['indicates reason for program being paused'] }, "Paused on {0}", this.stoppedDetails.reason) : nls.localize('paused', "Paused");
		}

		return nls.localize({ key: 'running', comment: ['indicates state'] }, "Running");
	}

	/**
	 * Queries the debug adapter for the callstack and returns a promise
	 * which completes once the call stack has been retrieved.
	 * If the thread is not stopped, it returns a promise to an empty array.
	 * Only fetches the first stack frame for performance reasons. Calling this method consecutive times
	 * gets the remainder of the call stack.
	 */
	fetchCallStack(levels = 20): Promise<void> {
		if (!this.stopped) {
			return Promise.resolve(undefined);
		}

		const start = this.callStack.length;
		return this.getCallStackImpl(start, levels).then(callStack => {
			if (start < this.callStack.length) {
				// Set the stack frames for exact position we requested. To make sure no concurrent requests create duplicate stack frames #30660
				this.callStack.splice(start, this.callStack.length - start);
			}
			this.callStack = this.callStack.concat(callStack || []);
		});
	}

	private getCallStackImpl(startFrame: number, levels: number): Promise<IStackFrame[]> {
		return this.session.stackTrace(this.threadId, startFrame, levels).then(response => {
			if (!response || !response.body) {
				return [];
			}

			if (this.stoppedDetails) {
				this.stoppedDetails.totalFrames = response.body.totalFrames;
			}

			return response.body.stackFrames.map((rsf, index) => {
				const source = this.session.getSource(rsf.source);

				return new StackFrame(this, rsf.id, source, rsf.name, rsf.presentationHint, new Range(
					rsf.line,
					rsf.column,
					rsf.endLine || rsf.line,
					rsf.endColumn || rsf.column
				), startFrame + index);
			});
		}, (err: Error) => {
			if (this.stoppedDetails) {
				this.stoppedDetails.framesErrorMessage = err.message;
			}

			return [];
		});
	}

	/**
	 * Returns exception info promise if the exception was thrown, otherwise undefined
	 */
	get exceptionInfo(): Promise<IExceptionInfo | undefined> {
		if (this.stoppedDetails && this.stoppedDetails.reason === 'exception') {
			if (this.session.capabilities.supportsExceptionInfoRequest) {
				return this.session.exceptionInfo(this.threadId);
			}
			return Promise.resolve({
				description: this.stoppedDetails.text,
				breakMode: null
			});
		}
		return Promise.resolve(undefined);
	}

	next(): Promise<any> {
		return this.session.next(this.threadId);
	}

	stepIn(): Promise<any> {
		return this.session.stepIn(this.threadId);
	}

	stepOut(): Promise<any> {
		return this.session.stepOut(this.threadId);
	}

	stepBack(): Promise<any> {
		return this.session.stepBack(this.threadId);
	}

	continue(): Promise<any> {
		return this.session.continue(this.threadId);
	}

	pause(): Promise<any> {
		return this.session.pause(this.threadId);
	}

	terminate(): Promise<any> {
		return this.session.terminateThreads([this.threadId]);
	}

	reverseContinue(): Promise<any> {
		return this.session.reverseContinue(this.threadId);
	}
}

export class Enablement implements IEnablement {
	constructor(
		public enabled: boolean,
		private id: string
	) { }

	getId(): string {
		return this.id;
	}
}

interface IBreakpointSessionData extends DebugProtocol.Breakpoint {
	supportsConditionalBreakpoints: boolean;
	supportsHitConditionalBreakpoints: boolean;
	supportsLogPoints: boolean;
	supportsFunctionBreakpoints: boolean;
	supportsDataBreakpoints: boolean;
}

function toBreakpointSessionData(data: DebugProtocol.Breakpoint, capabilities: DebugProtocol.Capabilities): IBreakpointSessionData {
	return mixin({
		supportsConditionalBreakpoints: !!capabilities.supportsConditionalBreakpoints,
		supportsHitConditionalBreakpoints: !!capabilities.supportsHitConditionalBreakpoints,
		supportsLogPoints: !!capabilities.supportsLogPoints,
		supportsFunctionBreakpoints: !!capabilities.supportsFunctionBreakpoints,
		supportsDataBreakpoints: !!capabilities.supportsDataBreakpoints
	}, data);
}

export abstract class BaseBreakpoint extends Enablement implements IBaseBreakpoint {

	private sessionData = new Map<string, IBreakpointSessionData>();
	protected data: IBreakpointSessionData | undefined;

	constructor(
		enabled: boolean,
		public hitCondition: string | undefined,
		public condition: string | undefined,
		public logMessage: string | undefined,
		id: string
	) {
		super(enabled, id);
		if (enabled === undefined) {
			this.enabled = true;
		}
	}

	setSessionData(sessionId: string, data: IBreakpointSessionData | undefined): void {
		if (!data) {
			this.sessionData.delete(sessionId);
		} else {
			this.sessionData.set(sessionId, data);
		}

		const allData = Array.from(this.sessionData.values());
		const verifiedData = distinct(allData.filter(d => d.verified), d => `${d.line}:${d.column}`);
		if (verifiedData.length) {
			// In case multiple session verified the breakpoint and they provide different data show the intial data that the user set (corner case)
			this.data = verifiedData.length === 1 ? verifiedData[0] : undefined;
		} else {
			// No session verified the breakpoint
			this.data = allData.length ? allData[0] : undefined;
		}
	}

	get message(): string | undefined {
		if (!this.data) {
			return undefined;
		}

		return this.data.message;
	}

	get verified(): boolean {
		return this.data ? this.data.verified : true;
	}

	abstract get supported(): boolean;

	getIdFromAdapter(sessionId: string): number | undefined {
		const data = this.sessionData.get(sessionId);
		return data ? data.id : undefined;
	}

	toJSON(): any {
		const result = Object.create(null);
		result.enabled = this.enabled;
		result.condition = this.condition;
		result.hitCondition = this.hitCondition;
		result.logMessage = this.logMessage;

		return result;
	}
}

export class Breakpoint extends BaseBreakpoint implements IBreakpoint {

	constructor(
		public uri: uri,
		private _lineNumber: number,
		private _column: number | undefined,
		enabled: boolean,
		condition: string | undefined,
		hitCondition: string | undefined,
		logMessage: string | undefined,
		private _adapterData: any,
		private textFileService: ITextFileService,
		id = generateUuid()
	) {
		super(enabled, hitCondition, condition, logMessage, id);
	}

	get lineNumber(): number {
		return this.verified && this.data && typeof this.data.line === 'number' ? this.data.line : this._lineNumber;
	}

	get verified(): boolean {
		if (this.data) {
			return this.data.verified && !this.textFileService.isDirty(this.uri);
		}

		return true;
	}

	get column(): number | undefined {
		return this.verified && this.data && typeof this.data.column === 'number' ? this.data.column : this._column;
	}

	get message(): string | undefined {
		if (this.textFileService.isDirty(this.uri)) {
			return nls.localize('breakpointDirtydHover', "Unverified breakpoint. File is modified, please restart debug session.");
		}

		return super.message;
	}

	get adapterData(): any {
		return this.data && this.data.source && this.data.source.adapterData ? this.data.source.adapterData : this._adapterData;
	}

	get endLineNumber(): number | undefined {
		return this.verified && this.data ? this.data.endLine : undefined;
	}

	get endColumn(): number | undefined {
		return this.verified && this.data ? this.data.endColumn : undefined;
	}

	get sessionAgnosticData(): { lineNumber: number, column: number | undefined } {
		return {
			lineNumber: this._lineNumber,
			column: this._column
		};
	}

	get supported(): boolean {
		if (!this.data) {
			return true;
		}
		if (this.logMessage && !this.data.supportsLogPoints) {
			return false;
		}
		if (this.condition && !this.data.supportsConditionalBreakpoints) {
			return false;
		}
		if (this.hitCondition && !this.data.supportsHitConditionalBreakpoints) {
			return false;
		}

		return true;
	}


	setSessionData(sessionId: string, data: IBreakpointSessionData | undefined): void {
		super.setSessionData(sessionId, data);
		if (!this._adapterData) {
			this._adapterData = this.adapterData;
		}
	}

	toJSON(): any {
		const result = super.toJSON();
		result.uri = this.uri;
		result.lineNumber = this._lineNumber;
		result.column = this._column;
		result.adapterData = this.adapterData;

		return result;
	}

	toString(): string {
		return resources.basenameOrAuthority(this.uri);
	}

	update(data: IBreakpointUpdateData): void {
		if (!isUndefinedOrNull(data.lineNumber)) {
			this._lineNumber = data.lineNumber;
		}
		if (!isUndefinedOrNull(data.column)) {
			this._column = data.column;
		}
		if (!isUndefinedOrNull(data.condition)) {
			this.condition = data.condition;
		}
		if (!isUndefinedOrNull(data.hitCondition)) {
			this.hitCondition = data.hitCondition;
		}
		if (!isUndefinedOrNull(data.logMessage)) {
			this.logMessage = data.logMessage;
		}
	}
}

export class FunctionBreakpoint extends BaseBreakpoint implements IFunctionBreakpoint {

	constructor(
		public name: string,
		enabled: boolean,
		hitCondition: string | undefined,
		condition: string | undefined,
		logMessage: string | undefined,
		id = generateUuid()
	) {
		super(enabled, hitCondition, condition, logMessage, id);
	}

	toJSON(): any {
		const result = super.toJSON();
		result.name = this.name;

		return result;
	}

	get supported(): boolean {
		if (!this.data) {
			return true;
		}

		return this.data.supportsFunctionBreakpoints;
	}

	toString(): string {
		return this.name;
	}
}

export class DataBreakpoint extends BaseBreakpoint implements IDataBreakpoint {

	constructor(
		public label: string,
		public dataId: string,
		public canPersist: boolean,
		enabled: boolean,
		hitCondition: string | undefined,
		condition: string | undefined,
		logMessage: string | undefined,
		id = generateUuid()
	) {
		super(enabled, hitCondition, condition, logMessage, id);
	}

	toJSON(): any {
		const result = super.toJSON();
		result.label = this.label;
		result.dataid = this.dataId;

		return result;
	}

	get supported(): boolean {
		if (!this.data) {
			return true;
		}

		return this.data.supportsDataBreakpoints;
	}

	toString(): string {
		return this.label;
	}
}

export class ExceptionBreakpoint extends Enablement implements IExceptionBreakpoint {

	constructor(public filter: string, public label: string, enabled: boolean) {
		super(enabled, generateUuid());
	}

	toJSON(): any {
		const result = Object.create(null);
		result.filter = this.filter;
		result.label = this.label;
		result.enabled = this.enabled;

		return result;
	}

	toString(): string {
		return this.label;
	}
}

export class ThreadAndSessionIds implements ITreeElement {
	constructor(public sessionId: string, public threadId: number) { }

	getId(): string {
		return `${this.sessionId}:${this.threadId}`;
	}
}

export class DebugModel implements IDebugModel {

	private sessions: IDebugSession[];
	private toDispose: lifecycle.IDisposable[];
	private schedulers = new Map<string, RunOnceScheduler>();
	private breakpointsActivated = true;
	private readonly _onDidChangeBreakpoints: Emitter<IBreakpointsChangeEvent | undefined>;
	private readonly _onDidChangeCallStack: Emitter<void>;
	private readonly _onDidChangeWatchExpressions: Emitter<IExpression | undefined>;

	constructor(
		private breakpoints: Breakpoint[],
		private functionBreakpoints: FunctionBreakpoint[],
		private exceptionBreakpoints: ExceptionBreakpoint[],
		private dataBreakopints: DataBreakpoint[],
		private watchExpressions: Expression[],
		private textFileService: ITextFileService
	) {
		this.sessions = [];
		this.toDispose = [];
		this._onDidChangeBreakpoints = new Emitter<IBreakpointsChangeEvent>();
		this._onDidChangeCallStack = new Emitter<void>();
		this._onDidChangeWatchExpressions = new Emitter<IExpression>();
	}

	getId(): string {
		return 'root';
	}

	getSession(sessionId: string | undefined, includeInactive = false): IDebugSession | undefined {
		if (sessionId) {
			return this.getSessions(includeInactive).filter(s => s.getId() === sessionId).pop();
		}
		return undefined;
	}

	getSessions(includeInactive = false): IDebugSession[] {
		// By default do not return inactive sesions.
		// However we are still holding onto inactive sessions due to repl and debug service session revival (eh scenario)
		return this.sessions.filter(s => includeInactive || s.state !== State.Inactive);
	}

	addSession(session: IDebugSession): void {
		this.sessions = this.sessions.filter(s => {
			if (s.getId() === session.getId()) {
				// Make sure to de-dupe if a session is re-intialized. In case of EH debugging we are adding a session again after an attach.
				return false;
			}
			if (s.state === State.Inactive && s.configuration.name === session.configuration.name) {
				// Make sure to remove all inactive sessions that are using the same configuration as the new session
				return false;
			}

			return true;
		});

		let index = -1;
		if (session.parentSession) {
			// Make sure that child sessions are placed after the parent session
			index = lastIndex(this.sessions, s => s.parentSession === session.parentSession || s === session.parentSession);
		}
		if (index >= 0) {
			this.sessions.splice(index + 1, 0, session);
		} else {
			this.sessions.push(session);
		}
		this._onDidChangeCallStack.fire(undefined);
	}

	get onDidChangeBreakpoints(): Event<IBreakpointsChangeEvent | undefined> {
		return this._onDidChangeBreakpoints.event;
	}

	get onDidChangeCallStack(): Event<void> {
		return this._onDidChangeCallStack.event;
	}

	get onDidChangeWatchExpressions(): Event<IExpression | undefined> {
		return this._onDidChangeWatchExpressions.event;
	}

	rawUpdate(data: IRawModelUpdate): void {
		let session = this.sessions.filter(p => p.getId() === data.sessionId).pop();
		if (session) {
			session.rawUpdate(data);
			this._onDidChangeCallStack.fire(undefined);
		}
	}

	clearThreads(id: string, removeThreads: boolean, reference: number | undefined = undefined): void {
		const session = this.sessions.filter(p => p.getId() === id).pop();
		this.schedulers.forEach(scheduler => scheduler.dispose());
		this.schedulers.clear();

		if (session) {
			session.clearThreads(removeThreads, reference);
			this._onDidChangeCallStack.fire(undefined);
		}
	}

	fetchCallStack(thread: Thread): { topCallStack: Promise<void>, wholeCallStack: Promise<void> } {
		if (thread.session.capabilities.supportsDelayedStackTraceLoading) {
			// For improved performance load the first stack frame and then load the rest async.
			let topCallStack = Promise.resolve();
			const wholeCallStack = new Promise<void>((c, e) => {
				topCallStack = thread.fetchCallStack(1).then(() => {
					if (!this.schedulers.has(thread.getId())) {
						this.schedulers.set(thread.getId(), new RunOnceScheduler(() => {
							thread.fetchCallStack(19).then(() => {
								const stale = thread.getStaleCallStack();
								const current = thread.getCallStack();
								let bottomOfCallStackChanged = stale.length !== current.length;
								for (let i = 1; i < stale.length && !bottomOfCallStackChanged; i++) {
									bottomOfCallStackChanged = !stale[i].equals(current[i]);
								}

								if (bottomOfCallStackChanged) {
									this._onDidChangeCallStack.fire();
								}
								c();
							});
						}, 420));
					}

					this.schedulers.get(thread.getId())!.schedule();
				});
				this._onDidChangeCallStack.fire();
			});

			return { topCallStack, wholeCallStack };
		}

		const wholeCallStack = thread.fetchCallStack();
		return { wholeCallStack, topCallStack: wholeCallStack };
	}

	getBreakpoints(filter?: { uri?: uri, lineNumber?: number, column?: number, enabledOnly?: boolean }): IBreakpoint[] {
		if (filter) {
			const uriStr = filter.uri ? filter.uri.toString() : undefined;
			return this.breakpoints.filter(bp => {
				if (uriStr && bp.uri.toString() !== uriStr) {
					return false;
				}
				if (filter.lineNumber && bp.lineNumber !== filter.lineNumber) {
					return false;
				}
				if (filter.column && bp.column !== filter.column) {
					return false;
				}
				if (filter.enabledOnly && (!this.breakpointsActivated || !bp.enabled)) {
					return false;
				}

				return true;
			});
		}

		return this.breakpoints;
	}

	getFunctionBreakpoints(): IFunctionBreakpoint[] {
		return this.functionBreakpoints;
	}

	getDataBreakpoints(): IDataBreakpoint[] {
		return this.dataBreakopints;
	}

	getExceptionBreakpoints(): IExceptionBreakpoint[] {
		return this.exceptionBreakpoints;
	}

	setExceptionBreakpoints(data: DebugProtocol.ExceptionBreakpointsFilter[]): void {
		if (data) {
			if (this.exceptionBreakpoints.length === data.length && this.exceptionBreakpoints.every((exbp, i) => exbp.filter === data[i].filter && exbp.label === data[i].label)) {
				// No change
				return;
			}

			this.exceptionBreakpoints = data.map(d => {
				const ebp = this.exceptionBreakpoints.filter(ebp => ebp.filter === d.filter).pop();
				return new ExceptionBreakpoint(d.filter, d.label, ebp ? ebp.enabled : !!d.default);
			});
			this._onDidChangeBreakpoints.fire(undefined);
		}
	}

	areBreakpointsActivated(): boolean {
		return this.breakpointsActivated;
	}

	setBreakpointsActivated(activated: boolean): void {
		this.breakpointsActivated = activated;
		this._onDidChangeBreakpoints.fire(undefined);
	}

	addBreakpoints(uri: uri, rawData: IBreakpointData[], fireEvent = true): IBreakpoint[] {
		const newBreakpoints = rawData.map(rawBp => new Breakpoint(uri, rawBp.lineNumber, rawBp.column, rawBp.enabled === false ? false : true, rawBp.condition, rawBp.hitCondition, rawBp.logMessage, undefined, this.textFileService, rawBp.id));
		this.breakpoints = this.breakpoints.concat(newBreakpoints);
		this.breakpointsActivated = true;
		this.sortAndDeDup();

		if (fireEvent) {
			this._onDidChangeBreakpoints.fire({ added: newBreakpoints });
		}

		return newBreakpoints;
	}

	removeBreakpoints(toRemove: IBreakpoint[]): void {
		this.breakpoints = this.breakpoints.filter(bp => !toRemove.some(toRemove => toRemove.getId() === bp.getId()));
		this._onDidChangeBreakpoints.fire({ removed: toRemove });
	}

	updateBreakpoints(data: Map<string, IBreakpointUpdateData>): void {
		const updated: IBreakpoint[] = [];
		this.breakpoints.forEach(bp => {
			const bpData = data.get(bp.getId());
			if (bpData) {
				bp.update(bpData);
				updated.push(bp);
			}
		});
		this.sortAndDeDup();
		this._onDidChangeBreakpoints.fire({ changed: updated });
	}

	setBreakpointSessionData(sessionId: string, capabilites: DebugProtocol.Capabilities, data: Map<string, DebugProtocol.Breakpoint> | undefined): void {
		this.breakpoints.forEach(bp => {
			if (!data) {
				bp.setSessionData(sessionId, undefined);
			} else {
				const bpData = data.get(bp.getId());
				if (bpData) {
					bp.setSessionData(sessionId, toBreakpointSessionData(bpData, capabilites));
				}
			}
		});
		this.functionBreakpoints.forEach(fbp => {
			if (!data) {
				fbp.setSessionData(sessionId, undefined);
			} else {
				const fbpData = data.get(fbp.getId());
				if (fbpData) {
					fbp.setSessionData(sessionId, toBreakpointSessionData(fbpData, capabilites));
				}
			}
		});
		this.dataBreakopints.forEach(dbp => {
			if (!data) {
				dbp.setSessionData(sessionId, undefined);
			} else {
				const dbpData = data.get(dbp.getId());
				if (dbpData) {
					dbp.setSessionData(sessionId, toBreakpointSessionData(dbpData, capabilites));
				}
			}
		});

		this._onDidChangeBreakpoints.fire({
			sessionOnly: true
		});
	}

	private sortAndDeDup(): void {
		this.breakpoints = this.breakpoints.sort((first, second) => {
			if (first.uri.toString() !== second.uri.toString()) {
				return resources.basenameOrAuthority(first.uri).localeCompare(resources.basenameOrAuthority(second.uri));
			}
			if (first.lineNumber === second.lineNumber) {
				if (first.column && second.column) {
					return first.column - second.column;
				}
				return -1;
			}

			return first.lineNumber - second.lineNumber;
		});
		this.breakpoints = distinct(this.breakpoints, bp => `${bp.uri.toString()}:${bp.lineNumber}:${bp.column}`);
	}

	setEnablement(element: IEnablement, enable: boolean): void {
		if (element instanceof Breakpoint || element instanceof FunctionBreakpoint || element instanceof ExceptionBreakpoint || element instanceof DataBreakpoint) {
			const changed: Array<IBreakpoint | IFunctionBreakpoint | IDataBreakpoint> = [];
			if (element.enabled !== enable && (element instanceof Breakpoint || element instanceof FunctionBreakpoint || element instanceof DataBreakpoint)) {
				changed.push(element);
			}

			element.enabled = enable;

			this._onDidChangeBreakpoints.fire({ changed: changed });
		}
	}

	enableOrDisableAllBreakpoints(enable: boolean): void {
		const changed: Array<IBreakpoint | IFunctionBreakpoint | IDataBreakpoint> = [];

		this.breakpoints.forEach(bp => {
			if (bp.enabled !== enable) {
				changed.push(bp);
			}
			bp.enabled = enable;
		});
		this.functionBreakpoints.forEach(fbp => {
			if (fbp.enabled !== enable) {
				changed.push(fbp);
			}
			fbp.enabled = enable;
		});
		this.dataBreakopints.forEach(dbp => {
			if (dbp.enabled !== enable) {
				changed.push(dbp);
			}
			dbp.enabled = enable;
		});

		this._onDidChangeBreakpoints.fire({ changed: changed });
	}

	addFunctionBreakpoint(functionName: string, id?: string): IFunctionBreakpoint {
		const newFunctionBreakpoint = new FunctionBreakpoint(functionName, true, undefined, undefined, undefined, id);
		this.functionBreakpoints.push(newFunctionBreakpoint);
		this._onDidChangeBreakpoints.fire({ added: [newFunctionBreakpoint] });

		return newFunctionBreakpoint;
	}

	renameFunctionBreakpoint(id: string, name: string): void {
		const functionBreakpoint = this.functionBreakpoints.filter(fbp => fbp.getId() === id).pop();
		if (functionBreakpoint) {
			functionBreakpoint.name = name;
			this._onDidChangeBreakpoints.fire({ changed: [functionBreakpoint] });
		}
	}

	removeFunctionBreakpoints(id?: string): void {
		let removed: FunctionBreakpoint[];
		if (id) {
			removed = this.functionBreakpoints.filter(fbp => fbp.getId() === id);
			this.functionBreakpoints = this.functionBreakpoints.filter(fbp => fbp.getId() !== id);
		} else {
			removed = this.functionBreakpoints;
			this.functionBreakpoints = [];
		}
		this._onDidChangeBreakpoints.fire({ removed });
	}

	addDataBreakpoint(label: string, dataId: string, canPersist: boolean): void {
		const newDataBreakpoint = new DataBreakpoint(label, dataId, canPersist, true, undefined, undefined, undefined);
		this.dataBreakopints.push(newDataBreakpoint);
		this._onDidChangeBreakpoints.fire({ added: [newDataBreakpoint] });
	}

	removeDataBreakpoints(id?: string): void {
		let removed: DataBreakpoint[];
		if (id) {
			removed = this.dataBreakopints.filter(fbp => fbp.getId() === id);
			this.dataBreakopints = this.dataBreakopints.filter(fbp => fbp.getId() !== id);
		} else {
			removed = this.dataBreakopints;
			this.dataBreakopints = [];
		}
		this._onDidChangeBreakpoints.fire({ removed });
	}

	getWatchExpressions(): Expression[] {
		return this.watchExpressions;
	}

	addWatchExpression(name: string): IExpression {
		const we = new Expression(name);
		this.watchExpressions.push(we);
		this._onDidChangeWatchExpressions.fire(we);

		return we;
	}

	renameWatchExpression(id: string, newName: string): void {
		const filtered = this.watchExpressions.filter(we => we.getId() === id);
		if (filtered.length === 1) {
			filtered[0].name = newName;
			this._onDidChangeWatchExpressions.fire(filtered[0]);
		}
	}

	removeWatchExpressions(id: string | null = null): void {
		this.watchExpressions = id ? this.watchExpressions.filter(we => we.getId() !== id) : [];
		this._onDidChangeWatchExpressions.fire(undefined);
	}

	moveWatchExpression(id: string, position: number): void {
		const we = this.watchExpressions.filter(we => we.getId() === id).pop();
		if (we) {
			this.watchExpressions = this.watchExpressions.filter(we => we.getId() !== id);
			this.watchExpressions = this.watchExpressions.slice(0, position).concat(we, this.watchExpressions.slice(position));
			this._onDidChangeWatchExpressions.fire(undefined);
		}
	}

	sourceIsNotAvailable(uri: uri): void {
		this.sessions.forEach(s => {
			const source = s.getSourceForUri(uri);
			if (source) {
				source.available = false;
			}
		});
		this._onDidChangeCallStack.fire(undefined);
	}

	dispose(): void {
		// Make sure to shutdown each session, such that no debugged process is left laying around
		this.sessions.forEach(s => s.shutdown());
		this.toDispose = lifecycle.dispose(this.toDispose);
	}
}
