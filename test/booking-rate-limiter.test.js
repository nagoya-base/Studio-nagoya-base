/*
 * gas/booking/RateLimiter.gs のテスト。CacheServiceはメモリ上のスタブに差し替える。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var DEFAULT_RATE_LIMIT_CONFIG = {
  emailCount: 3,
  emailWindowMinutes: 10,
  globalCount: 20,
  globalWindowMinutes: 1,
  duplicateWindowMinutes: 2
};

function loadRateLimiter(cacheServiceStub) {
  var sandbox = loadBookingSandbox(['RateLimiter.gs'], {
    CacheService: cacheServiceStub || stubs.createCacheServiceStub()
  });
  return sandbox.RateLimiter;
}

function input(overrides) {
  return Object.assign({ email: 'taro@example.com', date: '2026-10-01', startTime: '10:00', durationMinutes: 120 }, overrides || {});
}

test('evaluate: 同一メール10分以内3件までは許可し、4件目は拒否する', function () {
  var RateLimiter = loadRateLimiter();
  var now = Date.parse('2026-10-01T00:00:00+09:00');
  for (var i = 0; i < 3; i++) {
    var result = RateLimiter.evaluate(input({ startTime: (10 + i) + ':00' }), DEFAULT_RATE_LIMIT_CONFIG, now + i * 1000);
    assert.strictEqual(result.allowed, true, '1〜3件目は許可されるべき (i=' + i + ')');
  }
  var fourth = RateLimiter.evaluate(input({ startTime: '15:00' }), DEFAULT_RATE_LIMIT_CONFIG, now + 4000);
  assert.strictEqual(fourth.allowed, false);
  assert.strictEqual(fourth.reason, 'EMAIL_RATE_LIMIT');
});

test('evaluate: 10分経過後は同一メールのカウントがリセットされる', function () {
  var RateLimiter = loadRateLimiter();
  var now = Date.parse('2026-10-01T00:00:00+09:00');
  for (var i = 0; i < 3; i++) {
    RateLimiter.evaluate(input({ startTime: (10 + i) + ':00' }), DEFAULT_RATE_LIMIT_CONFIG, now + i * 1000);
  }
  var afterWindow = RateLimiter.evaluate(input({ startTime: '18:00' }), DEFAULT_RATE_LIMIT_CONFIG, now + 11 * 60000);
  assert.strictEqual(afterWindow.allowed, true, '10分経過後は再度許可されるべき');
});

test('evaluate: 全体で1分あたり20件を超えると異なるメールでも拒否する', function () {
  var RateLimiter = loadRateLimiter();
  var now = Date.parse('2026-10-01T00:00:00+09:00');
  for (var i = 0; i < 20; i++) {
    var result = RateLimiter.evaluate(
      input({ email: 'user' + i + '@example.com', startTime: '10:00' }),
      DEFAULT_RATE_LIMIT_CONFIG,
      now + i * 100
    );
    assert.strictEqual(result.allowed, true, '1〜20件目(異なるメール)は許可されるべき (i=' + i + ')');
  }
  var overLimit = RateLimiter.evaluate(input({ email: 'user21@example.com', startTime: '10:00' }), DEFAULT_RATE_LIMIT_CONFIG, now + 2100);
  assert.strictEqual(overLimit.allowed, false);
  assert.strictEqual(overLimit.reason, 'GLOBAL_RATE_LIMIT');
});

test('evaluate: 同一内容（email+date+startTime+durationMinutes）の連投は2件目を拒否する', function () {
  var RateLimiter = loadRateLimiter();
  var now = Date.parse('2026-10-01T00:00:00+09:00');
  var payload = input();
  var first = RateLimiter.evaluate(payload, DEFAULT_RATE_LIMIT_CONFIG, now);
  assert.strictEqual(first.allowed, true);

  var duplicate = RateLimiter.evaluate(payload, DEFAULT_RATE_LIMIT_CONFIG, now + 1000);
  assert.strictEqual(duplicate.allowed, false);
  assert.strictEqual(duplicate.reason, 'DUPLICATE_SUBMISSION');

  var differentTime = RateLimiter.evaluate(input({ startTime: '11:00' }), DEFAULT_RATE_LIMIT_CONFIG, now + 2000);
  assert.strictEqual(differentTime.allowed, true, '内容が異なれば連投扱いにしない');
});

test('evaluate: duplicateWindowMinutes経過後は同一内容の再送信を許可する', function () {
  var RateLimiter = loadRateLimiter();
  var now = Date.parse('2026-10-01T00:00:00+09:00');
  var payload = input();
  RateLimiter.evaluate(payload, DEFAULT_RATE_LIMIT_CONFIG, now);
  var afterWindow = RateLimiter.evaluate(payload, DEFAULT_RATE_LIMIT_CONFIG, now + 3 * 60000);
  assert.strictEqual(afterWindow.allowed, true);
});

test('evaluate: Script Propertiesで閾値を変更できる（設定値がそのまま使われる）', function () {
  var RateLimiter = loadRateLimiter();
  var now = Date.parse('2026-10-01T00:00:00+09:00');
  var strictConfig = Object.assign({}, DEFAULT_RATE_LIMIT_CONFIG, { emailCount: 1 });

  var first = RateLimiter.evaluate(input({ startTime: '10:00' }), strictConfig, now);
  assert.strictEqual(first.allowed, true);
  var second = RateLimiter.evaluate(input({ startTime: '11:00' }), strictConfig, now + 1000);
  assert.strictEqual(second.allowed, false);
  assert.strictEqual(second.reason, 'EMAIL_RATE_LIMIT');
});
