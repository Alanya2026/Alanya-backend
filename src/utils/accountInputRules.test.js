const assert = require('assert');
const { checkDisplayName, passwordHasWhitespace } = require('./accountInputRules');

for (const v of ['Chris', 'Jean-Pierre', "N'Diaye Aïcha", 'N’Diaye', 'chris_237', '张小明', '  Léa  ']) {
  assert.strictEqual(checkDisplayName('nom', v).ok, true, v);
}

for (const v of ['', null, undefined, 'Al', ' Al  ']) {
  const r = checkDisplayName('pseudo', v);
  assert.strictEqual(r.ok, false, String(v));
  assert.strictEqual(r.code, 'NAME_TOO_SHORT');
  assert.strictEqual(r.field, 'pseudo');
}

for (const v of ['chris.', 'Chris,Doe', 'a;bc', 'abc!', 'abc?', 'ch@ris', 'abc:', 'a/bc']) {
  const r = checkDisplayName('nom', v);
  assert.strictEqual(r.ok, false, v);
  assert.strictEqual(r.code, 'NAME_INVALID_CHARS', v);
}

assert.strictEqual(passwordHasWhitespace('abc123'), false);
assert.strictEqual(passwordHasWhitespace('P@ss.w0rd!'), false);
assert.strictEqual(passwordHasWhitespace('abc 123'), true);
assert.strictEqual(passwordHasWhitespace(' abc123'), true);
assert.strictEqual(passwordHasWhitespace('abc123\t'), true);

console.log('accountInputRules.test.js OK');
