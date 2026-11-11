import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// v110: "Add detail" on an image → video request. The rewriter only gets the words, never the photo, so it used to make
// the subject up ("this dog" with a Chihuahua attached came back as a golden retriever on a porch).
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('with a photo attached, a video prompt is rewritten by enhanceStill, without one by enhanceVideo', () => {
  assert.match(app, /SYS\[kind === 'video' \? \(e\.images\?\.length \? 'enhanceStill' : 'enhanceVideo'\) : 'enhanceImage'\]\(\)/);
});

test('enhanceStill never describes what is in the photo: it keeps the request\'s own words and adds motion only', () => {
  const m = /enhanceStill: \(\) => `([^`]+)`/.exec(app);
  assert.ok(m, 'enhanceStill is defined');
  const sys = m[1];
  assert.match(sys, /You cannot see it\./);
  assert.match(sys, /Never name a breed, species, color, person, place or object that the request doesn't name\./);
  assert.match(sys, /Call the subject what the request calls it/);
  assert.match(sys, /Describe only the motion, the camera movement and the mood/);
  assert.match(sys, /<prompt><\/prompt>/, 'helperAnswer reads the <prompt> tag');
});
