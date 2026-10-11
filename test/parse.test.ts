import assert from "node:assert/strict";
import test from "node:test";
import { array, boolean, dictionary, integer, json, literal, number, object, optional, parse, ParseError, parseJson, string } from "../src/parse.ts";

const message = object({ type: literal("ask", "watch"), content: optional(string), tries: optional(integer), tags: optional(array(string)) });

test("an object comes back with the fields it names, absent and null optional ones left out, and others ignored", () => {
	const parsed = parseJson('{"type":"ask","content":"hi","tries":null,"extra":1}', message, "the request");
	assert.deepEqual(parsed, { type: "ask", content: "hi" });
	assert.ok(!("tries" in parsed));
	const typed: { type: "ask" | "watch"; content?: string; tries?: number; tags?: string[] } = parsed;
	assert.equal(typed.type, "ask");
});

test("what's wrong is named with where it is", () => {
	const wrong = (text: string, pattern: RegExp) => assert.throws(() => parseJson(text, message, "the request"), (error) => error instanceof ParseError && pattern.test(error.message));
	wrong("{", /^the request isn't JSON$/);
	wrong("[]", /^the request should be an object$/);
	wrong('{"type":"stop"}', /^the request\.type should be "ask" or "watch"$/);
	wrong('{"type":"ask","tries":1.5}', /^the request\.tries should be a whole number$/);
	wrong('{"type":"ask","tags":["a",2]}', /^the request\.tags\[1\] should be a string$/);
	assert.throws(() => parse(undefined, number, "n"), /n should be a number/);
	assert.throws(() => parse(Number.NaN, number, "n"), /n should be a number/);
	assert.throws(() => parse("true", boolean, "b"), /b should be true or false/);
});

test("a dictionary is a Map of parsed values, and json takes any JSON value as it is", () => {
	assert.deepEqual(parse({ a: "x", b: "y" }, dictionary(string), "hosts"), new Map([["a", "x"], ["b", "y"]]));
	assert.throws(() => parse({ a: 1 }, dictionary(string), "hosts"), /hosts\.a should be a string/);
	assert.deepEqual(parse({ deep: [1, null] }, json, "data"), { deep: [1, null] });
	assert.throws(() => parse(undefined, json, "data"), /data should be present/);
});
