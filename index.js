#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import https from 'node:https';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';

// === Config ===
const CONFIG_PATH = join(__dirname, 'config.json');
const STATE_DIR = join(process.env.HOME, '.ats-review-responder');
const STATE_PATH = join(STATE_DIR, 'state.json');
const BOT_LOGIN = 'chatgpt-codex-connector[bot]';
const CLAUDE_BIN = '/usr/bin/claude';
const TELEGRAM_TOKEN = '8516158841:AAEiuEc956VdL0i6NIRqJ8o606ZYGV4AmDU';

let running = true;

// === Logging ===
function log(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// === Telegram ===
function telegram(chatId, text) {
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
  const req = https.request('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10000,
  }, (res) => {
    res.resume();
    if (res.statusCode !== 200) log('warn', 'Telegram API error', { statusCode: res.statusCode });
  });
  req.on('error', (err) => log('warn', 'Telegram send failed', { error: err.message }));
  req.write(body);
  req.end();
}

// === Config ===
function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

// === State management ===
function loadState() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(STATE_PATH)) return { processed: {} };
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return { processed: {} };
  }
}

function saveState(state) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function isProcessed(state, commentId) {
  return !!state.processed[String(commentId)];
}

function markProcessed(state, commentId, info) {
  state.processed[String(commentId)] = {
    processedAt: new Date().toISOString(),
    ...info,
  };
  saveState(state);
}

// === GitHub API via gh CLI ===
function gh(...args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    log('debug', 'gh command failed', { args, stderr: err.stderr?.slice(0, 500) });
    throw err;
  }
}

function ghAPI(endpoint) {
  return JSON.parse(gh('api', endpoint, '--paginate'));
}

function ghGraphQL(query, variables = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    args.push('-f', `${k}=${v}`);
  }
  return JSON.parse(gh(...args));
}

// === Git helpers ===
function git(cwd, ...args) {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    cwd,
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function ensureRepo(owner, repo, cloneBase) {
  const repoDir = join(cloneBase, `${owner}--${repo}`);
  if (!existsSync(repoDir)) {
    mkdirSync(cloneBase, { recursive: true });
    log('info', 'Cloning repo', { owner, repo, to: repoDir });
    execFileSync('git', ['clone', `https://github.com/${owner}/${repo}.git`, repoDir], {
      encoding: 'utf-8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    git(repoDir, 'fetch', '--all', '--prune');
  }
  return repoDir;
}

// === Discover open PRs with Codex bot comments ===
function getOpenPRs(owner, repo) {
  try {
    return ghAPI(`repos/${owner}/${repo}/pulls?state=open&per_page=100`);
  } catch (err) {
    log('error', 'Failed to list PRs', { owner, repo, error: err.message });
    return [];
  }
}

function getPRComments(owner, repo, prNumber) {
  try {
    return ghAPI(`repos/${owner}/${repo}/pulls/${prNumber}/comments`);
  } catch (err) {
    log('error', 'Failed to get PR comments', { owner, repo, prNumber, error: err.message });
    return [];
  }
}

function getPRDiff(owner, repo, prNumber) {
  try {
    return gh('api', `repos/${owner}/${repo}/pulls/${prNumber}`,
      '-H', 'Accept: application/vnd.github.diff');
  } catch (err) {
    log('warn', 'Failed to get PR diff', { owner, repo, prNumber, error: err.message });
    return '';
  }
}

// === Comment parsing ===
function isCodexBotComment(comment) {
  return comment.user?.login === BOT_LOGIN;
}

function isActionableComment(comment) {
  const body = comment.body || '';
  // Skip if it's just a review summary (no path = top-level review comment)
  if (!comment.path) return false;
  // Skip thumbs-up / approval comments
  if (/^\s*(👍|LGTM|Looks good|Approved)/i.test(body)) return false;
  return true;
}

function parseCommentInfo(comment) {
  const body = comment.body || '';

  // Extract title from bold text: **<badges> Title**
  let title = '';
  const titleMatch = body.match(/\*\*(?:<[^>]+>\s*)*(.+?)\*\*/);
  if (titleMatch) title = titleMatch[1].trim();

  // Extract the description (everything after the bold title line)
  let description = body;
  const boldEnd = body.indexOf('**', body.indexOf('**') + 2);
  if (boldEnd !== -1) {
    description = body.slice(boldEnd + 2).trim();
  }
  // Strip "Useful? React with ..." trailer
  description = description.replace(/\n*Useful\?\s*React with.*/s, '').trim();

  // Extract priority
  let priority = 'P2';
  const prioMatch = body.match(/!\[P(\d)/);
  if (prioMatch) priority = `P${prioMatch[1]}`;

  return {
    id: comment.id,
    nodeId: comment.node_id,
    path: comment.path,
    line: comment.line || comment.original_line,
    startLine: comment.start_line || comment.original_start_line,
    diffHunk: comment.diff_hunk,
    pullRequestReviewId: comment.pull_request_review_id,
    title,
    description,
    priority,
    rawBody: body,
  };
}

// === Get review thread ID for a comment ===
function getReviewThreadId(owner, repo, prNumber, commentDatabaseId) {
  const result = ghGraphQL(`
    query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes {
                  databaseId
                }
              }
            }
          }
        }
      }
    }
  `, { owner, repo, pr: String(prNumber) });

  const threads = result?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  for (const thread of threads) {
    const firstComment = thread.comments?.nodes?.[0];
    if (firstComment?.databaseId === commentDatabaseId) {
      return thread.id;
    }
  }
  return null;
}

function resolveThread(threadId) {
  try {
    ghGraphQL(`
      mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { isResolved }
        }
      }
    `, { threadId });
    return true;
  } catch (err) {
    log('warn', 'Failed to resolve thread', { threadId, error: err.message });
    return false;
  }
}

// === Claude Code invocation ===
function runClaude(prompt, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ['-p', '--dangerously-skip-permissions'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });

    child.stdin.write(prompt);
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, 300000); // 5 min

    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', () => {}); // drain

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGTERM' || code === 143) {
        reject(new Error('Claude timed out'));
      } else if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// === Read file from repo at specific branch ===
function readFileFromRepo(repoDir, filePath) {
  try {
    return readFileSync(join(repoDir, filePath), 'utf-8');
  } catch {
    return null;
  }
}

// === Process a single review comment ===
async function processComment(comment, pr, owner, repo, config, state) {
  const info = parseCommentInfo(comment);
  const prNumber = pr.number;
  const prBranch = pr.head.ref;
  const fullRepo = `${owner}/${repo}`;

  log('info', 'Processing comment', {
    commentId: info.id,
    repo: fullRepo,
    pr: prNumber,
    file: info.path,
    line: info.line,
    title: info.title,
    priority: info.priority,
  });

  // Clone/pull and checkout PR branch
  const cloneBase = config.clone_base || '/tmp/ats-review-responder';
  const repoDir = ensureRepo(owner, repo, cloneBase);

  git(repoDir, 'checkout', prBranch);
  git(repoDir, 'pull', 'origin', prBranch);

  // Read the file content
  const fileContent = readFileFromRepo(repoDir, info.path);
  if (fileContent === null) {
    log('warn', 'File not found in repo', { path: info.path, branch: prBranch });
    markProcessed(state, info.id, { skipped: true, reason: 'file_not_found' });
    return { success: false, reason: 'file_not_found' };
  }

  // Get PR diff for context
  const diff = getPRDiff(owner, repo, prNumber);

  // Build Claude prompt
  const prompt = `You are fixing a code review comment on the file "${info.path}" in the repository ${fullRepo}.

<review-comment>
<title>${info.title}</title>
<priority>${info.priority}</priority>
<file>${info.path}</file>
<line>${info.line || 'N/A'}</line>
<start-line>${info.startLine || 'N/A'}</start-line>
<description>
${info.description}
</description>
<diff-hunk>
${info.diffHunk || 'N/A'}
</diff-hunk>
</review-comment>

<file-content path="${info.path}">
${fileContent}
</file-content>

<pr-diff>
${diff.slice(0, 10000)}
</pr-diff>

Fix the specific issue raised in the review comment. Make a focused, minimal change to address the concern.
Do NOT add unrelated improvements. Only fix what the review comment asks for.
After making the change, do NOT commit or push — just edit the file(s).`;

  try {
    const output = await runClaude(prompt, repoDir);
    log('info', 'Claude completed', { commentId: info.id, outputLength: output.length });

    // Check if Claude actually made changes
    let hasChanges;
    try {
      const status = git(repoDir, 'status', '--porcelain');
      hasChanges = status.length > 0;
    } catch {
      hasChanges = false;
    }

    if (!hasChanges) {
      log('warn', 'Claude made no file changes', { commentId: info.id });
      markProcessed(state, info.id, { skipped: true, reason: 'no_changes' });
      return { success: false, reason: 'no_changes' };
    }

    // Commit the fix
    const summary = info.title || info.description.slice(0, 60);
    const commitMsg = `fix: address Codex review — ${summary}`;
    git(repoDir, 'add', '-A');
    git(repoDir, 'commit', '-m', commitMsg);

    // Push to PR branch
    git(repoDir, 'push', 'origin', prBranch);
    log('info', 'Pushed fix', { commentId: info.id, branch: prBranch, commit: commitMsg });

    // Resolve the review thread
    const threadId = getReviewThreadId(owner, repo, prNumber, info.id);
    let resolved = false;
    if (threadId) {
      resolved = resolveThread(threadId);
      log('info', 'Thread resolved', { commentId: info.id, threadId, resolved });
    } else {
      log('warn', 'Could not find thread ID to resolve', { commentId: info.id });
    }

    markProcessed(state, info.id, {
      fixed: true,
      commit: commitMsg,
      branch: prBranch,
      resolved,
    });

    return { success: true, commit: commitMsg, resolved };

  } catch (err) {
    log('error', 'Failed to process comment', { commentId: info.id, error: err.message });
    markProcessed(state, info.id, { skipped: true, reason: 'claude_error', error: err.message });
    return { success: false, reason: 'claude_error', error: err.message };
  }
}

// === Single poll cycle ===
async function pollOnce(config, state, repoFilter) {
  const repos = config.repos || [];
  const results = { processed: 0, fixed: 0, skipped: 0, errors: 0 };

  for (const { owner, repo } of repos) {
    if (repoFilter && `${owner}/${repo}` !== repoFilter) continue;

    log('info', 'Checking repo', { owner, repo });

    const prs = getOpenPRs(owner, repo);
    log('info', 'Found open PRs', { owner, repo, count: prs.length });

    for (const pr of prs) {
      if (!running) break;

      const comments = getPRComments(owner, repo, pr.number);
      const botComments = comments.filter(c => isCodexBotComment(c) && isActionableComment(c));

      for (const comment of botComments) {
        if (!running) break;
        if (isProcessed(state, comment.id)) {
          log('debug', 'Already processed', { commentId: comment.id });
          continue;
        }

        results.processed++;
        const result = await processComment(comment, pr, owner, repo, config, state);
        if (result.success) {
          results.fixed++;
        } else if (result.reason === 'claude_error') {
          results.errors++;
        } else {
          results.skipped++;
        }
      }
    }
  }

  return results;
}

// === Main polling loop ===
async function pollLoop(config, state, repoFilter) {
  const interval = config.poll_interval_ms || 60000;

  while (running) {
    try {
      const results = await pollOnce(config, state, repoFilter);
      if (results.processed > 0) {
        log('info', 'Poll cycle complete', results);
      }
    } catch (err) {
      log('error', 'Poll cycle failed', { error: err.message });
    }

    // Sleep
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, interval);
      const stop = () => { clearTimeout(timer); resolve(); };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
    });
  }
}

// === Preflight ===
function preflight() {
  // Check gh
  try {
    const ghVersion = execFileSync('gh', ['--version'], {
      encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n')[0];
    log('info', 'Preflight: gh', { version: ghVersion });
  } catch (err) {
    log('error', 'Preflight failed: gh not found', { error: err.message });
    process.exit(1);
  }

  // Check claude
  try {
    const claudeVersion = execFileSync(CLAUDE_BIN, ['--version'], {
      encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    log('info', 'Preflight: claude', { version: claudeVersion });
  } catch (err) {
    log('error', 'Preflight failed: claude not found', { error: err.message });
    process.exit(1);
  }

  // Check gh auth
  try {
    execFileSync('gh', ['auth', 'status'], {
      encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    log('info', 'Preflight: gh auth OK');
  } catch (err) {
    log('error', 'Preflight failed: gh not authenticated', { error: err.message });
    process.exit(1);
  }
}

// === Shutdown ===
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

// === CLI ===
const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    once: { type: 'boolean', default: false },
    repo: { type: 'string' },
  },
  strict: false,
  allowPositionals: true,
});

async function main() {
  const config = loadConfig();
  const state = loadState();

  log('info', `ats-review-responder v${VERSION} starting`, {
    repos: config.repos.map(r => `${r.owner}/${r.repo}`),
    pollInterval: config.poll_interval_ms,
    once: flags.once,
    repoFilter: flags.repo || null,
    stateFile: STATE_PATH,
    processedCount: Object.keys(state.processed).length,
  });

  preflight();

  if (flags.once) {
    const results = await pollOnce(config, state, flags.repo);
    log('info', 'Single poll complete', results);

    if (config.telegram_chat_id && results.processed > 0) {
      telegram(config.telegram_chat_id,
        `<b>ats-review-responder</b> poll complete\n` +
        `Fixed: ${results.fixed} | Skipped: ${results.skipped} | Errors: ${results.errors}`
      );
    }
  } else {
    log('info', 'Starting poll loop');
    await pollLoop(config, state, flags.repo);
    log('info', 'Shutting down');
  }
}

main().catch((err) => {
  log('error', 'Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
