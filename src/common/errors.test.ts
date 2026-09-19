import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyResponseStatus, classifyThrownError } from './errors.js';

function systemError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`simulated ${code}`);
  error.code = code;
  return error;
}

describe('classifyResponseStatus', () => {
  it('treats 429 as transient — the sink is asking us to slow down, not refusing the work', () => {
    assert.equal(classifyResponseStatus(429), 'transient');
  });

  it('treats every 5xx as transient', () => {
    for (const status of [500, 502, 503, 504]) {
      assert.equal(classifyResponseStatus(status), 'transient', `status ${status}`);
    }
  });

  it('treats 4xx other than 429 as permanent — retrying a rejected document never helps', () => {
    for (const status of [400, 404, 409, 422]) {
      assert.equal(classifyResponseStatus(status), 'permanent', `status ${status}`);
    }
  });

  it('treats success codes as permanent so a miscall cannot silently become a retry loop', () => {
    assert.equal(classifyResponseStatus(200), 'permanent');
  });
});

describe('classifyThrownError', () => {
  it('treats connection-level system errors as transient', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']) {
      assert.equal(classifyThrownError(systemError(code)), 'transient', code);
    }
  });

  it('treats an elasticsearch client connection failure as transient', () => {
    const error = new Error('connect timeout');
    error.name = 'ConnectionError';
    assert.equal(classifyThrownError(error), 'transient');
  });

  it('defers to the status code when the error carries one', () => {
    const throttled = Object.assign(new Error('too many requests'), { statusCode: 429 });
    const rejected = Object.assign(new Error('mapper_parsing_exception'), { statusCode: 400 });

    assert.equal(classifyThrownError(throttled), 'transient');
    assert.equal(classifyThrownError(rejected), 'permanent');
  });

  it('treats an unrecognised error as permanent so it surfaces instead of looping', () => {
    assert.equal(classifyThrownError(new Error('something unexpected')), 'permanent');
  });

  it('survives a thrown non-Error', () => {
    assert.equal(classifyThrownError('a string'), 'permanent');
    assert.equal(classifyThrownError(null), 'permanent');
    assert.equal(classifyThrownError(undefined), 'permanent');
  });
});
