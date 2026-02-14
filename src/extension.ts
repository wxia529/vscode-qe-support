import * as fs from 'fs';
import * as vscode from 'vscode';

type CompletionSection = {
	sectionType: string;
	variables: Record<string, CompletionVariable>;
	cardOptions?: {
		options: string[];
		default?: string | null;
	};
};

type CompletionVariable = {
	name: string;
	section: string;
	sectionType: string;
	type: string;
	default: string | null;
	description: string | null;
	options: string[];
	units: string | null;
	range: string | null;
	constraints: CompletionConstraints | null;
};

type CompletionConstraints = {
	requires: string[];
	conflicts: string[];
	implies: string[];
	validWhen: string[];
};

type CompletionData = {
	sections: Record<string, CompletionSection>;
};

type DiagnosticEntry = {
	type: string;
	options: string[];
	default: string | null;
	range: string | null;
	units: string | null;
	section: string;
};

type DiagnosticData = {
	variables: Record<string, DiagnosticEntry>;
};

type ConstraintData = {
	variables: Record<string, CompletionConstraints>;
};

type RangeEntry = {
	range: string | null;
	units: string | null;
};

type RangeData = {
	variables: Record<string, RangeEntry>;
};

const SUPPORTED_LANGUAGES: (string | vscode.DocumentFilter)[] = [
	{ language: 'qe-input', scheme: 'file' },
	{ language: 'plaintext', scheme: 'file' }
];

const DATA_FILES = {
	completion: 'data/completion.json',
	diagnostics: 'data/diagnostics.json',
	constraints: 'data/constraints.json',
	ranges: 'data/ranges.json'
} as const;

export function activate(context: vscode.ExtensionContext) {
	const store = new DataStore(context);

	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(
			SUPPORTED_LANGUAGES,
			new CompletionProvider(store),
			'&',
			'=',
			' ',
			'('
		)
	);

	const diagnosticsCollection = vscode.languages.createDiagnosticCollection('qe-support');
	context.subscriptions.push(diagnosticsCollection);

	const diagnosticsProvider = new DiagnosticsProvider(store, diagnosticsCollection);
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((doc) => diagnosticsProvider.refresh(doc))
	);
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((event) => diagnosticsProvider.refresh(event.document))
	);
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument((doc) => diagnosticsProvider.clear(doc))
	);

	context.subscriptions.push(
		vscode.languages.registerHoverProvider(
			SUPPORTED_LANGUAGES,
			new HoverProvider(store)
		)
	);
}

export function deactivate() {}

class DataStore {
	private completion: CompletionData | null = null;
	private diagnostics: DiagnosticData | null = null;
	private constraints: ConstraintData | null = null;
	private ranges: RangeData | null = null;
	private lastLoadError: string | null = null;

	constructor(private readonly context: vscode.ExtensionContext) {}

	getCompletionData(): CompletionData | null {
		this.ensureLoaded();
		return this.completion;
	}

	getDiagnosticsData(): DiagnosticData | null {
		this.ensureLoaded();
		return this.diagnostics;
	}

	getConstraints(): ConstraintData | null {
		this.ensureLoaded();
		return this.constraints;
	}

	getRanges(): RangeData | null {
		this.ensureLoaded();
		return this.ranges;
	}

	getLastError(): string | null {
		return this.lastLoadError;
	}

	private ensureLoaded(): void {
		if (this.completion && this.diagnostics && this.constraints && this.ranges) {
			return;
		}
		try {
			this.completion = this.loadJson<CompletionData>(DATA_FILES.completion);
			this.diagnostics = this.loadJson<DiagnosticData>(DATA_FILES.diagnostics);
			this.constraints = this.loadJson<ConstraintData>(DATA_FILES.constraints);
			this.ranges = this.loadJson<RangeData>(DATA_FILES.ranges);
			this.lastLoadError = null;
		} catch (error) {
			this.lastLoadError = error instanceof Error ? error.message : String(error);
		}
	}

	private loadJson<T>(relativePath: string): T {
		const uri = vscode.Uri.joinPath(this.context.extensionUri, relativePath);
		const content = fs.readFileSync(uri.fsPath, 'utf8');
		return JSON.parse(content) as T;
	}
}

class CompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly store: DataStore) {}

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.CompletionItem[] {
		const data = this.store.getCompletionData();
		if (!data) {
			return [];
		}

		const lineText = document.lineAt(position.line).text;
		const cardName = findCardNameAtLine(data.sections, lineText);
		if (cardName) {
			const cardSection = data.sections[cardName];
			return this.buildCardOptionItems(cardSection, lineText);
		}
		if (lineText.trim().startsWith('&')) {
			return this.buildSectionItems(data.sections);
		}

		const section = findCurrentSection(document, position.line);
		if (!section) {
			return [];
		}
		const sectionData = data.sections[section];
		if (!sectionData) {
			return [];
		}

		if (lineText.includes('=')) {
			const variableName = lineText.split('=')[0].trim();
			return this.buildValueItems(sectionData, variableName);
		}

		return this.buildVariableItems(sectionData);
	}

	private buildSectionItems(sections: Record<string, CompletionSection>): vscode.CompletionItem[] {
		return Object.keys(sections).map((section) => {
			const item = new vscode.CompletionItem(section, vscode.CompletionItemKind.Keyword);
			item.insertText = section;
			item.detail = sections[section].sectionType;
			return item;
		});
	}

	private buildVariableItems(section: CompletionSection): vscode.CompletionItem[] {
		return Object.keys(section.variables).map((name) => {
			const variable = section.variables[name];
			const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
			item.detail = variable.type;
			item.documentation = buildVariableMarkdown(variable, null, null);
			return item;
		});
	}

	private buildValueItems(section: CompletionSection, variableName: string): vscode.CompletionItem[] {
		const variable = section.variables[variableName];
		if (!variable || !variable.options || variable.options.length === 0) {
			return [];
		}
		return variable.options.map((option) => {
			const item = new vscode.CompletionItem(option, vscode.CompletionItemKind.Value);
			item.detail = variable.type;
			item.documentation = buildVariableMarkdown(variable, option, null);
			return item;
		});
	}

	private buildCardOptionItems(
		section: CompletionSection,
		lineText: string
	): vscode.CompletionItem[] {
		if (!section.cardOptions || section.cardOptions.options.length === 0) {
			return [];
		}
		const wantsParen = lineText.includes('(');
		return section.cardOptions.options.map((option) => {
			const item = new vscode.CompletionItem(option, vscode.CompletionItemKind.Value);
			item.insertText = wantsParen ? `${option})` : option;
			return item;
		});
	}
}

class DiagnosticsProvider {
	constructor(
		private readonly store: DataStore,
		private readonly collection: vscode.DiagnosticCollection
	) {}

	refresh(document: vscode.TextDocument): void {
		if (!isSupportedDocument(document)) {
			return;
		}

		const diagnostics: vscode.Diagnostic[] = [];
		diagnostics.push(...findSectionClosureIssues(document));
		const data = this.store.getDiagnosticsData();
		const constraints = this.store.getConstraints();
		const ranges = this.store.getRanges();
		if (!data) {
			return;
		}

		const parsed = parseAssignments(document.getText());
		const assignmentIndex = indexAssignments(parsed);
		for (const entry of parsed) {
			const key = `${entry.section}.${entry.name}`;
			const def = data.variables[key];
			if (!def) {
				continue;
			}
			const issues = validateEntry(entry, def, constraints, ranges, assignmentIndex);
			for (const issue of issues) {
				diagnostics.push(
					new vscode.Diagnostic(entry.range, issue, vscode.DiagnosticSeverity.Warning)
				);
			}
		}

		this.collection.set(document.uri, diagnostics);
	}

	clear(document: vscode.TextDocument): void {
		this.collection.delete(document.uri);
	}
}

type SectionIssue = {
	message: string;
	range: vscode.Range;
};

function findSectionClosureIssues(document: vscode.TextDocument): vscode.Diagnostic[] {
	const issues: SectionIssue[] = [];
	let openSection: { name: string; line: number } | null = null;

	for (let index = 0; index < document.lineCount; index += 1) {
		const line = document.lineAt(index).text;
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		if (trimmed.startsWith('!') || trimmed.startsWith('#')) {
			continue;
		}

		if (trimmed.startsWith('&')) {
			const sectionName = normalizeSection(trimmed);
			if (openSection) {
				issues.push({
					message: `Section ${openSection.name} is not closed with '/'.`,
					range: new vscode.Range(
						new vscode.Position(openSection.line, 0),
						new vscode.Position(openSection.line, document.lineAt(openSection.line).text.length)
					)
				});
			}
			openSection = { name: sectionName, line: index };
			continue;
		}

		const withoutComment = stripInlineComment(line).trim();
		if (withoutComment === '/') {
			if (!openSection) {
				issues.push({
					message: "Stray '/' without an open section.",
					range: new vscode.Range(
						new vscode.Position(index, 0),
						new vscode.Position(index, line.length)
					)
				});
			} else {
				openSection = null;
			}
		}
	}

	if (openSection) {
		issues.push({
			message: `Section ${openSection.name} is not closed with '/'.`,
			range: new vscode.Range(
				new vscode.Position(openSection.line, 0),
				new vscode.Position(openSection.line, document.lineAt(openSection.line).text.length)
			)
		});
	}

	return issues.map(
		(issue) => new vscode.Diagnostic(issue.range, issue.message, vscode.DiagnosticSeverity.Warning)
	);
}

class HoverProvider implements vscode.HoverProvider {
	constructor(private readonly store: DataStore) {}

	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
		const data = this.store.getCompletionData();
		if (!data) {
			return null;
		}
		const entry = findEntryAtPosition(document, position);
		if (!entry) {
			return null;
		}
		const sectionData = data.sections[entry.section];
		if (!sectionData) {
			return null;
		}
		const variable = sectionData.variables[entry.name];
		if (!variable) {
			return null;
		}
		return new vscode.Hover(buildVariableMarkdown(variable, entry.value, this.store.getRanges()));
	}
}

type ParsedEntry = {
	section: string;
	name: string;
	value: string;
	range: vscode.Range;
};

type AssignmentIndex = {
	bySection: Record<string, Record<string, string>>;
};

function isSupportedDocument(document: vscode.TextDocument): boolean {
	return SUPPORTED_LANGUAGES.some((selector) => {
		if (typeof selector === 'string') {
			return selector === document.languageId;
		}
		return selector.language === document.languageId && selector.scheme === document.uri.scheme;
	});
}

function parseAssignments(text: string): ParsedEntry[] {
	const lines = text.split(/\r?\n/);
	const entries: ParsedEntry[] = [];
	let currentSection = '';

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trim();
		if (trimmed.startsWith('&')) {
			currentSection = normalizeSection(trimmed);
			continue;
		}
		if (!currentSection || trimmed === '/' || trimmed.startsWith('!') || trimmed.startsWith('#')) {
			continue;
		}
		const withoutComment = stripInlineComment(line);
		const parts = splitAssignments(withoutComment);
		for (const part of parts) {
			const eqIndex = part.indexOf('=');
			if (eqIndex <= 0) {
				continue;
			}
			const name = part.slice(0, eqIndex).trim();
			const value = part.slice(eqIndex + 1).trim();
			if (!name) {
				continue;
			}
			const range = new vscode.Range(
				new vscode.Position(index, 0),
				new vscode.Position(index, line.length)
			);
			entries.push({ section: currentSection, name, value, range });
		}
	}

	return entries;
}

function stripInlineComment(line: string): string {
	let inSingleQuote = false;
	let inDoubleQuote = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			continue;
		}
		if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}
		if (!inSingleQuote && !inDoubleQuote && (char === '!' || char === '#')) {
			return line.slice(0, index);
		}
	}
	return line;
}

function splitAssignments(line: string): string[] {
	const parts: string[] = [];
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let depth = 0;
	let start = 0;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			continue;
		}
		if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}
		if (!inSingleQuote && !inDoubleQuote) {
			if (char === '(' || char === '[' || char === '{') {
				depth += 1;
				continue;
			}
			if (char === ')' || char === ']' || char === '}') {
				depth = Math.max(0, depth - 1);
				continue;
			}
			if (char === ',' && depth === 0) {
				parts.push(line.slice(start, index).trim());
				start = index + 1;
			}
		}
	}
	const last = line.slice(start).trim();
	if (last) {
		parts.push(last);
	}
	return parts.length > 0 ? parts : [line];
}

function indexAssignments(entries: ParsedEntry[]): AssignmentIndex {
	const bySection: Record<string, Record<string, string>> = {};
	for (const entry of entries) {
		if (!bySection[entry.section]) {
			bySection[entry.section] = {};
		}
		bySection[entry.section][entry.name] = entry.value;
	}
	return { bySection };
}

function findCurrentSection(document: vscode.TextDocument, line: number): string | null {
	for (let index = line; index >= 0; index -= 1) {
		const trimmed = document.lineAt(index).text.trim();
		if (trimmed.startsWith('&')) {
			return normalizeSection(trimmed);
		}
		if (trimmed === '/' && index < line) {
			return null;
		}
	}
	return null;
}

function findCardNameAtLine(
	sections: Record<string, CompletionSection>,
	lineText: string
): string | null {
	const trimmed = lineText.trimStart();
	if (!trimmed) {
		return null;
	}
	const candidates = Object.keys(sections).filter(
		(sectionName) => sections[sectionName].sectionType === 'card'
	);
	for (const name of candidates) {
		if (trimmed.startsWith(name)) {
			return name;
		}
	}
	return null;
}

function normalizeSection(raw: string): string {
	const match = raw.match(/^&\s*([A-Za-z0-9_]+)/);
	if (!match) {
		return raw.trim();
	}
	return `& ${match[1]}`;
}

function findEntryAtPosition(document: vscode.TextDocument, position: vscode.Position): ParsedEntry | null {
	const parsed = parseAssignments(document.getText());
	for (const entry of parsed) {
		if (entry.range.contains(position)) {
			return entry;
		}
	}
	return null;
}

function validateEntry(
	entry: ParsedEntry,
	def: DiagnosticEntry,
	constraints: ConstraintData | null,
	ranges: RangeData | null,
	assignmentIndex: AssignmentIndex
): string[] {
	const messages: string[] = [];
	if (def.options.length > 0 && !valueInOptions(entry.value, def.options)) {
		messages.push(`Value '${entry.value}' is not in the allowed options.`);
	}
	if (def.range && !valueMatchesRange(entry.value, def.range)) {
		messages.push(`Value '${entry.value}' is outside the allowed range ${def.range}.`);
	}
	if (ranges) {
		const rangeInfo = ranges.variables[`${entry.section}.${entry.name}`];
		if (rangeInfo && rangeInfo.range && !valueMatchesRange(entry.value, rangeInfo.range)) {
			messages.push(`Value '${entry.value}' violates range ${rangeInfo.range}.`);
		}
	}
	if (constraints) {
		const constraint = constraints.variables[`${entry.section}.${entry.name}`];
		if (constraint && constraint.validWhen.length > 0) {
			const evalResult = evaluateConditions(constraint.validWhen, entry.section, assignmentIndex);
			if (evalResult === false) {
				messages.push(`Condition not satisfied: ${constraint.validWhen.join('; ')}.`);
			}
		}
	}
	return messages;
}

function valueMatchesRange(value: string, range: string): boolean {
	if (range.includes('..')) {
		const [minRaw, maxRaw] = range.split('..');
		const min = parseNumber(minRaw);
		const max = parseNumber(maxRaw);
		const numeric = parseNumber(value);
		if (min !== null && max !== null && numeric !== null) {
			return numeric >= min && numeric <= max;
		}
	}
	const inequalityMatch = range.match(
		/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?)\s*(<=|<)\s*x\s*(<=|<)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?)\s*$/i
	);
	if (inequalityMatch) {
		const [, minRaw, minOp, maxOp, maxRaw] = inequalityMatch;
		const min = parseNumber(minRaw);
		const max = parseNumber(maxRaw);
		const numeric = parseNumber(value);
		if (min !== null && max !== null && numeric !== null) {
			const lowerOk = minOp === '<' ? numeric > min : numeric >= min;
			const upperOk = maxOp === '<' ? numeric < max : numeric <= max;
			return lowerOk && upperOk;
		}
	}
	return true;
}

function evaluateConditions(
	conditions: string[],
	section: string,
	assignmentIndex: AssignmentIndex
): boolean | null {
	let evaluated = 0;
	for (const condition of conditions) {
		const result = evaluateCondition(condition, section, assignmentIndex);
		if (result === null) {
			continue;
		}
		evaluated += 1;
		if (!result) {
			return false;
		}
	}
	if (evaluated === 0) {
		return null;
	}
	return true;
}

function evaluateCondition(
	condition: string,
	section: string,
	assignmentIndex: AssignmentIndex
): boolean | null {
	const normalized = condition.replace(/\s+/g, ' ').trim();
	const operatorMatch = normalized.match(/(.+?)\s*(==|=|\/=|>=|<=|>|<)\s*(.+)/);
	if (!operatorMatch) {
		return null;
	}
	const [, rawLeft, op, rawRight] = operatorMatch;
	const leftName = rawLeft.trim();
	const leftValue = resolveValue(leftName, section, assignmentIndex);
	if (leftValue === null) {
		return null;
	}
	const rightValue = rawRight.trim();
	return compareValues(leftValue, rightValue, op);
}

function resolveValue(
	name: string,
	section: string,
	assignmentIndex: AssignmentIndex
): string | null {
	if (name.includes('.')) {
		const [rawSection, rawName] = name.split('.', 2).map((part) => part.trim());
		if (rawSection && rawName) {
			const normalizedSection = rawSection.startsWith('&')
				? normalizeSection(rawSection)
				: `& ${rawSection.replace(/^&\s*/, '')}`;
			const sectionValues = assignmentIndex.bySection[normalizedSection];
			if (sectionValues && rawName in sectionValues) {
				return sectionValues[rawName];
			}
		}
	}
	const sectionValues = assignmentIndex.bySection[section];
	if (sectionValues && name in sectionValues) {
		return sectionValues[name];
	}
	let foundValue: string | null = null;
	for (const values of Object.values(assignmentIndex.bySection)) {
		if (name in values) {
			if (foundValue !== null) {
				return null;
			}
			foundValue = values[name];
		}
	}
	if (foundValue !== null) {
		return foundValue;
	}
	return null;
}

function compareValues(left: string, right: string, op: string): boolean {
	const leftNorm = normalizeValue(left);
	const rightNorm = normalizeValue(right);
	const leftNum = parseNumber(leftNorm);
	const rightNum = parseNumber(rightNorm);
	if (leftNum !== null && rightNum !== null) {
		return compareNumbers(leftNum, rightNum, op);
	}
	if (op === '/' || op === '/=') {
		return leftNorm !== rightNorm;
	}
	if (op === '==' || op === '=') {
		return leftNorm === rightNorm;
	}
	return true;
}

function compareNumbers(left: number, right: number, op: string): boolean {
	if (op === '==') {
		return left === right;
	}
	if (op === '=') {
		return left === right;
	}
	if (op === '/=' || op === '/') {
		return left !== right;
	}
	if (op === '>') {
		return left > right;
	}
	if (op === '<') {
		return left < right;
	}
	if (op === '>=') {
		return left >= right;
	}
	if (op === '<=') {
		return left <= right;
	}
	return true;
}

function normalizeValue(value: string): string {
	const trimmed = value.trim();
	const bool = normalizeBoolean(trimmed);
	return bool ?? trimmed;
}

function normalizeBoolean(value: string): string | null {
	if (/^\.?true\.?$/i.test(value)) {
		return '.true.';
	}
	if (/^\.?false\.?$/i.test(value)) {
		return '.false.';
	}
	return null;
}

function parseNumber(value: string): number | null {
	const trimmed = value.trim().replace(/[dD]/g, 'e');
	if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(trimmed)) {
		return null;
	}
	const parsed = Number(trimmed);
	return Number.isNaN(parsed) ? null : parsed;
}

function valueInOptions(value: string, options: string[]): boolean {
	const normalizedValue = normalizeValue(value);
	return options.some((option) => normalizeValue(option) === normalizedValue);
}

function buildVariableMarkdown(
	variable: CompletionVariable,
	currentValue: string | null,
	ranges: RangeData | null
): vscode.MarkdownString {
	const lines: string[] = [];
	lines.push(`**${variable.name}**`);
	if (variable.description) {
		lines.push(variable.description);
	}
	if (variable.type) {
		lines.push(`Type: ${variable.type}`);
	}
	if (variable.default) {
		lines.push(`Default: ${variable.default}`);
	}
	if (variable.options && variable.options.length > 0) {
		lines.push(`Options: ${variable.options.join(', ')}`);
	}
	if (variable.units) {
		lines.push(`Units: ${variable.units}`);
	}
	const rangeInfo = ranges?.variables[`${variable.section}.${variable.name}`];
	if (rangeInfo?.range) {
		lines.push(`Range: ${rangeInfo.range}`);
	}
	if (currentValue) {
		lines.push(`Current: ${currentValue}`);
	}
	return new vscode.MarkdownString(lines.join('\n\n'));
}
