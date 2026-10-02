import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildCompatibilityExpression } from '../src/core/payload.js';

function inspect({ main = true, thread = false, composer = false } = {}) {
  const root = { setAttribute() {}, getAttribute(name) { return name === 'data-codexskin' ? 'active' : 'example'; } };
  return vm.runInNewContext(buildCompatibilityExpression('example'), {
    window: { location: { hash: '' } },
    document: {
      documentElement: root,
      getElementById(id) { return id === 'codexskin-style' ? { textContent: 'styles' } : { style: { backgroundImage: 'url(image)', opacity: '1' }, getBoundingClientRect() { return { height: 100 }; } }; },
      querySelector() { return null; },
      querySelectorAll(selector) {
        return Array(selector === '[role="main"], main' ? Number(main) : selector.startsWith('.thread-scroll') ? Number(thread) : selector.includes('_ComposerLayoutRoot_') ? Number(composer) : 0);
      }
    }
  });
}

test('compatibility does not require chat-only targets on non-chat pages', () => {
  assert.equal(inspect().warnings.length, 0);
});
test('compatibility explains missing main and chat composer targets', () => {
  const result = inspect({ main: false, thread: true });
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join(' '), /may be hidden/);
});
