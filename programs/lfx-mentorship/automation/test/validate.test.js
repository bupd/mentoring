'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  emailRe, urlRe, ghHandleRe, lfidRe,
  isHttpUrl, extractLfidFromProfileUrl, extractLfxMentorId,
  extractVerifiedLfidFromOpenProfileJson, githubHandleFromUrl, mentorGithubHandleFromJson,
  mentorProfileUrls, normalizeMentorProfileUrls, openProfileCandidatesForGithub,
  validateMentors, validateUpstreamUrl,
} = require('../lib/validate');

const codes = (result) => result.errors.map(e => e.code);

test('validateMentors: a full valid 4-field line passes with no errors', () => {
  assert.deepEqual(
    validateMentors('Jane Doe | @janedoe | jane@example.com | janedoe'),
    { ok: true, count: 1, errors: [] },
  );
});

test('validateMentors: empty field flags "empty"', () => {
  assert.deepEqual(validateMentors(''), { ok: false, count: 0, errors: [{ role: null, code: 'empty' }] });
  assert.deepEqual(validateMentors('   '), { ok: false, count: 0, errors: [{ role: null, code: 'empty' }] });
});

test('validateMentors: a 3-field line flags missing LFID (optional at submit, required to pass)', () => {
  assert.deepEqual(
    validateMentors('Jane Doe | @janedoe | jane@example.com').errors,
    [{ role: 'Primary mentor', code: 'lfid-missing' }],
  );
});

test('validateMentors: a 4-field line with empty trailing LFID also flags missing', () => {
  assert.deepEqual(codes(validateMentors('Jane Doe | @janedoe | jane@example.com | ')), ['lfid-missing']);
});

test('validateMentors: wrong field counts flag "count" and skip the line', () => {
  assert.deepEqual(codes(validateMentors('Jane Doe | @janedoe')), ['count']);
  assert.deepEqual(codes(validateMentors('Jane | @j | j@x.com | jlfid | extra')), ['count']);
});

test('validateMentors: the "count" error carries the offending line for the message', () => {
  const e = validateMentors('Jane Doe | @janedoe').errors[0];
  assert.equal(e.code, 'count');
  assert.equal(e.got, 2);
  assert.equal(e.line, 'Jane Doe | @janedoe');
});

test('validateMentors: a malformed LFID (URL) flags "lfid-format"', () => {
  assert.deepEqual(
    codes(validateMentors('Jane Doe | @janedoe | jane@example.com | https://openprofile.dev/profile/janedoe')),
    ['lfid-format'],
  );
});

test('isHttpUrl: accepts http(s) only', () => {
  assert.equal(isHttpUrl('https://openprofile.dev/profile/janedoe'), true);
  assert.equal(isHttpUrl('http://openprofile.dev/profile/janedoe'), true);
  assert.equal(isHttpUrl('ftp://openprofile.dev/profile/janedoe'), false);
  assert.equal(isHttpUrl('janedoe'), false);
});

test('extractLfidFromProfileUrl: extracts LFID from OpenProfile public profile URLs', () => {
  assert.equal(extractLfidFromProfileUrl('https://openprofile.dev/profile/janedoe'), 'janedoe');
  assert.equal(extractLfidFromProfileUrl('https://www.openprofile.dev/profile/jane.doe-1_x/'), 'jane.doe-1_x');
});

test('extractLfidFromProfileUrl: extracts LFID from fetched page content', () => {
  assert.equal(
    extractLfidFromProfileUrl(
      'https://mentorship.lfx.linuxfoundation.org/profile/abc',
      '<a href="https://openprofile.dev/profile/janedoe">OpenProfile</a>',
    ),
    'janedoe',
  );
  assert.equal(
    extractLfidFromProfileUrl('https://example.com/profile/abc', '{"lfUsername":"janedoe"}'),
    'janedoe',
  );
});

test('extractLfidFromProfileUrl: returns empty for unknown or invalid values', () => {
  assert.equal(extractLfidFromProfileUrl('https://openprofile.dev/profile/jane/doe'), '');
  assert.equal(extractLfidFromProfileUrl('not a url', '<html></html>'), '');
});

test('extractLfxMentorId: extracts mentor IDs from public and API URLs', () => {
  const id = '67d1c219-c704-4321-aa76-8471139fff5c';
  assert.equal(extractLfxMentorId(`https://mentorship.lfx.linuxfoundation.org/mentor/${id}`), id);
  assert.equal(extractLfxMentorId(`https://api.mentorship.lfx.linuxfoundation.org/mentors?id=${id}`), id);
  assert.equal(extractLfxMentorId('https://example.com/mentor/67d1c219-c704-4321-aa76-8471139fff5c'), '');
});

test('githubHandleFromUrl: extracts a GitHub handle from profile URLs', () => {
  assert.equal(githubHandleFromUrl('https://github.com/Vad1mo'), 'Vad1mo');
  assert.equal(githubHandleFromUrl('https://github.com/bupd/mentoring'), 'bupd');
  assert.equal(githubHandleFromUrl('https://example.com/bupd'), '');
});

test('mentorGithubHandleFromJson: extracts GitHub handle from LFX mentor API JSON', () => {
  const mentorJson = JSON.stringify({
    users: [{
      profiles: [{
        type: 'mentor',
        profileLinks: { githubProfileLink: 'https://github.com/Vad1mo' },
      }],
    }],
  });
  assert.equal(mentorGithubHandleFromJson(mentorJson), 'Vad1mo');
  assert.equal(mentorGithubHandleFromJson('{}'), '');
});

test('openProfileCandidatesForGithub: tries exact GitHub handle then lowercase fallback', () => {
  assert.deepEqual(openProfileCandidatesForGithub('Vad1mo'), ['Vad1mo', 'vad1mo']);
  assert.deepEqual(openProfileCandidatesForGithub('bupd'), ['bupd']);
});

test('extractVerifiedLfidFromOpenProfileJson: accepts LFID only when GitHub ID matches', () => {
  assert.equal(
    extractVerifiedLfidFromOpenProfileJson(
      JSON.stringify({ basic: { Username: 'vad1mo', GithubID: 'Vad1mo' } }),
      'Vad1mo',
    ),
    'vad1mo',
  );
  assert.equal(
    extractVerifiedLfidFromOpenProfileJson(
      JSON.stringify({ basic: { Username: 'somebody', GithubID: 'SomebodyElse' } }),
      'Vad1mo',
    ),
    '',
  );
});

test('mentorProfileUrls: finds URL values in the LFID column only', () => {
  assert.deepEqual(
    mentorProfileUrls(
      'Jane Doe | @janedoe | jane@example.com | https://openprofile.dev/profile/janedoe\n' +
      'Sam Lee | @samlee | sam@example.com | samlee\n' +
      'Bad | @bad | https://openprofile.dev/profile/not-lfid',
    ),
    ['https://openprofile.dev/profile/janedoe'],
  );
});

test('normalizeMentorProfileUrls: replaces resolved profile URLs with LFIDs', () => {
  const raw = [
    'Jane Doe | @janedoe | jane@example.com | https://openprofile.dev/profile/janedoe',
    'Sam Lee | @samlee | sam@example.com | samlee',
  ].join('\n');
  assert.deepEqual(
    normalizeMentorProfileUrls(raw, {
      'https://openprofile.dev/profile/janedoe': 'janedoe',
    }),
    {
      value: [
        'Jane Doe | @janedoe | jane@example.com | janedoe',
        'Sam Lee | @samlee | sam@example.com | samlee',
      ].join('\n'),
      replacements: [{ line: 1, url: 'https://openprofile.dev/profile/janedoe', lfid: 'janedoe' }],
    },
  );
});

test('normalizeMentorProfileUrls: leaves unresolved URLs unchanged', () => {
  const raw = 'Jane Doe | @janedoe | jane@example.com | https://example.com/profile/janedoe';
  assert.deepEqual(normalizeMentorProfileUrls(raw, {}), { value: raw, replacements: [] });
});

test('validateMentors: bad handle and email are both flagged on one line', () => {
  const result = validateMentors('Jane Doe | janedoe | not-an-email | janedoe');
  assert.deepEqual(codes(result), ['handle', 'email']);
  assert.deepEqual(result.errors.map(e => e.role), ['Primary mentor', 'Primary mentor']);
});

test('validateMentors: more than four mentors flags "too-many" but still checks lines', () => {
  const five = Array.from({ length: 5 }, (_, i) => `M${i} | @m${i} | m${i}@x.com | lf${i}`).join('\n');
  const result = validateMentors(five);
  assert.equal(result.count, 5);
  assert.ok(result.errors.some(e => e.code === 'too-many' && e.count === 5));
});

test('validateMentors: duplicate handle, email, and LFID are each flagged on the later line', () => {
  const dupHandle = validateMentors('A | @dup | a@x.com | la\nB | @dup | b@x.com | lb');
  assert.ok(dupHandle.errors.some(e => e.code === 'dup-handle' && e.role === 'Mentor 2'));

  const dupEmail = validateMentors('A | @a | same@x.com | la\nB | @b | same@x.com | lb');
  assert.ok(dupEmail.errors.some(e => e.code === 'dup-email' && e.role === 'Mentor 2'));

  const dupLfid = validateMentors('A | @a | a@x.com | shared\nB | @b | b@x.com | shared');
  assert.ok(dupLfid.errors.some(e => e.code === 'dup-lfid' && e.role === 'Mentor 2'));
});

test('validateUpstreamUrl: classifies empty, malformed, multiple, and valid', () => {
  assert.equal(validateUpstreamUrl(''), 'empty');
  assert.equal(validateUpstreamUrl('not a url'), 'format');
  // A comma with no whitespace passes the URL regex, then trips the single-URL check.
  assert.equal(validateUpstreamUrl('https://example.com/a,https://example.com/b'), 'multiple');
  assert.equal(validateUpstreamUrl('https://github.com/cncf/mentoring/issues/1'), null);
});

test('validateUpstreamUrl: whitespace fails the URL regex first (format, not multiple)', () => {
  // urlRe requires \S+$, so any space yields "format" before the single-URL check.
  assert.equal(validateUpstreamUrl('https://example.com/a, https://example.com/b'), 'format');
});

test('lfidRe: accepts plain usernames and dot/dash/underscore', () => {
  assert.equal(lfidRe.test('janedoe'), true);
  assert.equal(lfidRe.test('jane.doe-1_x'), true);
});

test('lfidRe: rejects empty, spaces, emails, and URLs', () => {
  assert.equal(lfidRe.test(''), false);
  assert.equal(lfidRe.test('jane doe'), false);
  assert.equal(lfidRe.test('jane@example.com'), false);
  assert.equal(lfidRe.test('https://openprofile.dev/profile/janedoe'), false);
});

test('emailRe / ghHandleRe / urlRe: basic accept and reject', () => {
  assert.equal(emailRe.test('jane@example.com'), true);
  assert.equal(emailRe.test('jane@example'), false);
  assert.equal(ghHandleRe.test('@jane-doe'), true);
  assert.equal(ghHandleRe.test('jane'), false);
  assert.equal(urlRe.test('https://example.com/x'), true);
  assert.equal(urlRe.test('ftp://example.com'), false);
});
