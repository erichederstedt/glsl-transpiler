/**
 * Source map support.
 *
 * Line numbers survive preprocessing by tagging each source line before `prepr`
 * runs and reading the tags back afterwards. Statements are located in the
 * output by markers which the `stmt` transform puts in front of its code; the
 * markers are removed and turned into mappings once the output is assembled.
 *
 * @module  glsl-transpiler/lib/sourcemap
 */
import { SourceMapGenerator } from 'source-map'

// Neither character can occur in GLSL source or in generated JavaScript.
const TAG = '\u0002', MARK = '\u0001'
const tagRE = /\u0002(\d+)\u0002/g, markRE = /\u0001(\d+)\u0001/

/** Join backslash-continued lines, keeping the line count by adding the newlines back after the joined line. */
export function joinContinuations(source) {
	const lines = source.split('\n'), result = []
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i], joined = 0
		while (/\\\r?$/.test(line) && i + 1 < lines.length) { line = line.replace(/\\\r?$/, ' ') + lines[++i]; joined++ }
		result.push(line + '\n'.repeat(joined))
	}
	return result.join('\n')
}

/** Prefix every line that has code with its line number. Directive lines are left alone so prepr reads them unchanged. */
export function tagLines(source) {
	return source.split('\n').map((line, i) => /^\s*(?:#|$)/.test(line) ? line : TAG + i + TAG + line).join('\n')
}

/** Remove the tags from preprocessed code, returning it with the original line of each of its lines. */
export function untagLines(code) {
	const lines = []
	code = code.split('\n').map((line, i) => {
		const tag = new RegExp(tagRE.source).exec(line)
		lines.push(tag ? +tag[1] : i ? lines[i - 1] + 1 : 0)
		return line.replace(tagRE, '')
	}).join('\n')
	return { code, lines }
}

/** Returns a function from an offset in `code` to its 0-based line and column in the original source. */
export function locator(code, lines) {
	const starts = [0]
	for (let i = code.indexOf('\n'); i >= 0; i = code.indexOf('\n', i + 1)) starts.push(i + 1)
	return offset => {
		let lo = 0, hi = starts.length - 1
		while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1 }
		return { line: lines ? lines[lo] : lo, column: offset - starts[lo] }
	}
}

export function marker(offset) { return MARK + offset + MARK }

/**
 * Remove markers from `code` and build the source map. Each marker maps its own
 * position; a generated line without a marker at its start maps to the statement
 * that was active before it, so multi-line expansions of one statement stay mapped.
 * Lines holding only closing braces are left unmapped.
 */
export function extractMap(code, locate, { source = 'shader.glsl', file, content } = {}) {
	const marks = [], parts = code.split(new RegExp(markRE.source))
	let output = '', line = 0, column = 0
	for (let i = 0; i < parts.length; i++) {
		if (i % 2) { marks.push({ line, column, original: locate(+parts[i]) }); continue }
		const text = parts[i], lastBreak = text.lastIndexOf('\n')
		output += text
		if (lastBreak < 0) column += text.length
		else { line += text.split('\n').length - 1; column = text.length - lastBreak - 1 }
	}

	const generator = new SourceMapGenerator(file ? { file } : {})
	if (content != null) generator.setSourceContent(source, content)
	const add = (line, column, original) => generator.addMapping({
		source, generated: { line: line + 1, column }, original: { line: original.line + 1, column: original.column }
	})

	let active = null, m = 0
	output.split('\n').forEach((text, i) => {
		const indent = text.search(/\S/)
		const first = marks[m]?.line === i ? marks[m] : null
		if (active && indent >= 0 && !/^\s*\}[\s;]*$/.test(text) && (!first || first.column > indent)) add(i, indent, active)
		for (; marks[m]?.line === i; m++) { add(i, marks[m].column, marks[m].original); active = marks[m].original }
	})

	return { code: output, map: generator.toJSON() }
}
