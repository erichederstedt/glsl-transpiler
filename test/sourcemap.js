import GLSL from '../index.js'
import CompileStream from '../stream.js'
import test from 'tape'
import { Readable } from 'node:stream'
import { SourceMapConsumer } from 'source-map'
import { readFileSync } from 'node:fs'

const source = `precision mediump float;
#define SCALE 2.0
#ifdef MISSING
float unused;
float unused2;
#else
uniform vec2 u;
#endif
#define TWICE(a) \\
  (a * SCALE)
float twice(float x) {
  return TWICE(x);
}
void main() {
  vec2 a = u * SCALE;
  if (a.x > 1.0) a.y = 0.0;
  gl_FragColor = vec4(a, twice(a.x), 1.0);
}`

// The original line that the first code on each generated line maps to.
async function originalLines(code, map) {
	return SourceMapConsumer.with(map, null, consumer => code.split('\n').map((line, i) => {
		const column = line.search(/\S/)
		return column < 0 ? null : consumer.originalPositionFor({ line: i + 1, column }).line
	}))
}

// tape 4 does not wait for promises
function atest(name, run) {
	test(name, t => { run(t).then(() => t.end(), error => { t.error(error); t.end() }) })
}

function lineOf(code, text) { return code.split('\n').findIndex(line => line.includes(text)) }

atest('sourceMap: output is unchanged and statements map to their GLSL lines', async t => {
	const compile = GLSL({ sourceMap: { source: 'shader.frag', file: 'shader.js' } })
	const code = compile(source)
	t.equal(code, GLSL()(source), 'same code as without source maps')
	t.notOk(/[\u0001\u0002]/.test(code), 'no markers left')

	const map = compile.compiler.map
	t.equal(map.version, 3)
	t.equal(map.file, 'shader.js')
	t.deepEqual(map.sources, ['shader.frag'])
	t.deepEqual(map.sourcesContent, [source])

	const lines = await originalLines(code, map)
	const expect = (text, line) => t.equal(lines[lineOf(code, text)], line, `${text} -> line ${line}`)
	expect('var u =', 7) // after a skipped #ifdef branch
	expect('function twice', 11) // after a continued #define
	expect('return (x * 2.0)', 12) // macro expanded
	expect('function main', 14)
	expect('var a =', 15)
	expect('a[1] = 0.0', 16) // unbraced if body
	expect('gl_FragColor', 17)
})

atest('sourceMap: columns point at the statement in the source', async t => {
	const compile = GLSL({ sourceMap: true })
	const code = compile('void main() {\n  float a = 1.0; float b = a;\n}')
	await SourceMapConsumer.with(compile.compiler.map, null, consumer => {
		const line = lineOf(code, 'var b') + 1
		const position = consumer.originalPositionFor({ line, column: code.split('\n')[line - 1].search(/\S/) })
		t.deepEqual([position.source, position.line, position.column], ['shader.glsl', 2, 17])
	})
})

atest('sourceMap: multi-line expansions of a statement stay mapped', async t => {
	const compile = GLSL({ sourceMap: true })
	const code = compile('void f(out float x) {\n  x = 1.0;\n  return;\n}')
	const lines = await originalLines(code, compile.compiler.map)
	t.equal(lines[lineOf(code, 'f.__out__')], 3)
	t.equal(lines[lineOf(code, 'return;')], 3)
	t.equal(lines[code.split('\n').lastIndexOf('};')], null, 'closing brace is unmapped')
})

atest('sourceMap: stdlib helpers are unmapped and the map is reset', async t => {
	const compile = GLSL({ sourceMap: true })
	const code = compile('float a = mod(5.0, 3.0);')
	const lines = await originalLines(code, compile.compiler.map)
	t.equal(lines[lineOf(code, 'function mod')], null)
	t.equal(lines[lineOf(code, 'var a =')], 1)

	compile(compile.compiler.parse('float b;'))
	t.equal(compile.compiler.map, null, 'no map for a precompiled tree')
	const plain = GLSL()
	plain('float c;')
	t.equal(plain.compiler.map, null, 'off by default')
})

test('sourceMap: sourcesContent can be left out', t => {
	const compile = GLSL({ sourceMap: { sourcesContent: false } })
	compile('float a;')
	t.notOk(compile.compiler.map.sourcesContent)
	t.end()
})

atest('sourceMap: custom preprocessors are trusted to keep lines', async t => {
	const compile = GLSL({ sourceMap: true, preprocess: code => code.replace(/VALUE/g, '2.0') })
	const code = compile('\n\nfloat a = VALUE;')
	const lines = await originalLines(code, compile.compiler.map)
	t.equal(lines[lineOf(code, 'var a')], 3)
})

test('sourceMap: the grammar fixture compiles to identical code', t => {
	const fixture = readFileSync(new URL('./fixture/source1.glsl', import.meta.url), 'utf8')
	t.equal(GLSL({ sourceMap: true })(fixture), GLSL()(fixture))
	t.end()
})

test('sourceMap: streams expose the map', t => {
	const stream = CompileStream({ sourceMap: true })
	let code = ''
	stream.on('data', chunk => code += chunk)
	stream.on('end', () => {
		t.ok(code.includes('var u'))
		t.deepEqual(stream.map.sources, ['shader.glsl'])
		t.end()
	})
	Readable.from(['uniform ', 'vec2 u;']).pipe(stream)
})
