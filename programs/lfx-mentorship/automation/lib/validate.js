'use strict';

// Field validation shared by the LFX proposal workflows.
//
// The regexes are lifted verbatim from lfx-proposal-validate.yml. validateMentors
// and validateUpstreamUrl capture the decision logic of that workflow's mentor
// loop (validate.yml mentor block) and Upstream Issue URL check as pure
// functions that return structured error codes (presentation stays in the
// workflow). Error codes, not prose, are the stable contract.

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const urlRe = /^https?:\/\/\S+$/;
const ghHandleRe = /^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// LF Username (LFID): a single token, no spaces, '@', or URL slashes.
const lfidRe = /^[^\s@/]+$/;
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function extractLfidFromProfileUrl(value, pageText = '') {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const profilePath = url.pathname.match(/^\/profile\/([^/?#]+)\/?$/);
    if ((host === 'openprofile.dev' || host === 'www.openprofile.dev') && profilePath) {
      const lfid = decodeURIComponent(profilePath[1]);
      if (lfidRe.test(lfid)) return lfid;
    }
  } catch {
    // Not a URL; fall through to page content checks.
  }

  const patterns = [
    /https?:\/\/(?:www\.)?openprofile\.dev\/profile\/([^\s"'<>/?#]+)/i,
    /"lfUsername"\s*:\s*"([^"]+)"/i,
    /"lf_username"\s*:\s*"([^"]+)"/i,
    /"lfid"\s*:\s*"([^"]+)"/i,
  ];
  for (const pattern of patterns) {
    const match = pageText.match(pattern);
    if (match && lfidRe.test(match[1])) return match[1];
  }
  return '';
}

function extractLfxMentorId(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const mentorPath = url.pathname.match(/^\/mentor\/([^/?#]+)\/?$/);
    if (host === 'mentorship.lfx.linuxfoundation.org' && mentorPath) {
      return uuidRe.test(mentorPath[1]) ? mentorPath[1] : '';
    }
    if (host === 'api.mentorship.lfx.linuxfoundation.org' && url.pathname === '/mentors') {
      const id = url.searchParams.get('id') || '';
      return uuidRe.test(id) ? id : '';
    }
  } catch {}
  return '';
}

function githubHandleFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com') return '';
    const handle = url.pathname.split('/').filter(Boolean)[0] || '';
    return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(handle) ? handle : '';
  } catch {
    return '';
  }
}

function mentorGithubHandleFromJson(raw) {
  try {
    const data = JSON.parse(raw);
    const user = data.users?.[0] || data;
    const mentor = user.profiles?.find(p => p.type === 'mentor') || user.profiles?.[0] || user;
    return githubHandleFromUrl(mentor.profileLinks?.githubProfileLink || '');
  } catch {
    return '';
  }
}

function openProfileCandidatesForGithub(githubHandle) {
  return [...new Set([githubHandle, githubHandle.toLowerCase()].filter(Boolean))];
}

function extractVerifiedLfidFromOpenProfileJson(raw, expectedGithubHandle) {
  try {
    const data = JSON.parse(raw);
    const username = data.basic?.Username || '';
    const githubID = data.basic?.GithubID || '';
    if (!lfidRe.test(username)) return '';
    if (expectedGithubHandle && githubID.toLowerCase() !== expectedGithubHandle.toLowerCase()) {
      return '';
    }
    return username;
  } catch {
    return '';
  }
}

function mentorProfileUrls(raw) {
  if (!raw) return [];
  return raw.split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map((line) => line.split('|').map(p => p.trim()))
    .filter(parts => parts.length === 4 && isHttpUrl(parts[3]))
    .map(parts => parts[3]);
}

function normalizeMentorProfileUrls(raw, resolvedLfids) {
  if (!raw) return { value: raw || '', replacements: [] };
  const replacements = [];
  const lines = raw.split(/\r?\n/).map((line, i) => {
    if (!line.trim()) return line;
    const parts = line.split('|').map(p => p.trim());
    if (parts.length !== 4 || !isHttpUrl(parts[3])) return line;

    const lfid = resolvedLfids[parts[3]];
    if (!lfid || !lfidRe.test(lfid)) return line;

    replacements.push({ line: i + 1, url: parts[3], lfid });
    parts[3] = lfid;
    return parts.join(' | ');
  });
  return { value: lines.join('\n'), replacements };
}

// Validate the Mentors field (pipe-separated, one mentor per line).
// Returns { ok, count, errors }, where each error is { role, code, ... }.
// Codes: 'empty', 'too-many', 'count', 'name', 'handle', 'email',
//        'dup-handle', 'dup-email', 'lfid-missing', 'lfid-format', 'dup-lfid'.
function validateMentors(raw) {
  const errors = [];
  if (!raw || !raw.trim()) {
    errors.push({ role: null, code: 'empty' });
    return { ok: false, count: 0, errors };
  }

  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 4) {
    errors.push({ role: null, code: 'too-many', count: lines.length });
  }

  const handles = new Set();
  const emails = new Set();
  const lfids = new Set();

  lines.forEach((line, i) => {
    const role = i === 0 ? 'Primary mentor' : `Mentor ${i + 1}`;
    const parts = line.split('|').map(p => p.trim());

    if (parts.length !== 3 && parts.length !== 4) {
      errors.push({ role, code: 'count', got: parts.length, line });
      return;
    }

    const [name, handle, email, lfid] = parts;

    if (!name) errors.push({ role, code: 'name' });
    if (!ghHandleRe.test(handle)) errors.push({ role, code: 'handle', value: handle });
    if (!emailRe.test(email)) errors.push({ role, code: 'email', value: email });

    if (handles.has(handle.toLowerCase())) errors.push({ role, code: 'dup-handle', value: handle });
    handles.add(handle.toLowerCase());

    if (emails.has(email.toLowerCase())) errors.push({ role, code: 'dup-email', value: email });
    emails.add(email.toLowerCase());

    if (!lfid) {
      errors.push({ role, code: 'lfid-missing' });
    } else if (!lfidRe.test(lfid)) {
      errors.push({ role, code: 'lfid-format', value: lfid });
    } else if (lfids.has(lfid.toLowerCase())) {
      errors.push({ role, code: 'dup-lfid', value: lfid });
    }
    if (lfid) lfids.add(lfid.toLowerCase());
  });

  return { ok: errors.length === 0, count: lines.length, errors };
}

// Validate the Upstream Issue URL field. Returns a single error code or null.
// Codes: 'empty', 'format', 'multiple'.
function validateUpstreamUrl(raw) {
  const url = (raw || '').trim();
  if (!url) return 'empty';
  if (!urlRe.test(url)) return 'format';
  if (url.includes(',')) return 'multiple';
  return null;
}

module.exports = {
  emailRe,
  urlRe,
  ghHandleRe,
  lfidRe,
  isHttpUrl,
  extractLfidFromProfileUrl,
  extractLfxMentorId,
  githubHandleFromUrl,
  mentorGithubHandleFromJson,
  openProfileCandidatesForGithub,
  extractVerifiedLfidFromOpenProfileJson,
  mentorProfileUrls,
  normalizeMentorProfileUrls,
  validateMentors,
  validateUpstreamUrl,
};
