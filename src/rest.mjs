// A tiny Octokit-shaped GitHub REST client over Node 20's global `fetch`, so the
// action has ZERO npm dependencies (nothing to `npm install` or vendor in the
// composite action, and nothing to keep up to date). It exposes only the handful
// of methods src/github.mjs calls, with the SAME shape Octokit's `.rest` uses
// ({ data }), so the mocked unit tests and the real client are interchangeable.

/** The GitHub REST base URL. Read lazily (per call) so it honors GITHUB_API_URL for GHES/tests. */
function apiBase() {
  return process.env.GITHUB_API_URL || "https://api.github.com";
}

/**
 * @param {string} token  a GitHub token (GITHUB_TOKEN) with the needed scopes
 * @returns {{ rest: object }} an object whose `.rest` matches the subset used
 */
export function makeRest(token) {
  async function call(method, path, body) {
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "dig-network-deploy-action",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = data && data.message ? data.message : `${res.status} ${res.statusText}`;
      const err = new Error(`GitHub API ${method} ${path} failed: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return { data };
  }

  return {
    rest: {
      issues: {
        listComments: ({ owner, repo, issue_number, per_page = 100 }) =>
          call("GET", `/repos/${owner}/${repo}/issues/${issue_number}/comments?per_page=${per_page}`),
        createComment: ({ owner, repo, issue_number, body }) =>
          call("POST", `/repos/${owner}/${repo}/issues/${issue_number}/comments`, { body }),
        updateComment: ({ owner, repo, comment_id, body }) =>
          call("PATCH", `/repos/${owner}/${repo}/issues/comments/${comment_id}`, { body }),
      },
      repos: {
        createDeployment: ({ owner, repo, ...rest }) =>
          call("POST", `/repos/${owner}/${repo}/deployments`, rest),
        createDeploymentStatus: ({ owner, repo, deployment_id, ...rest }) =>
          call("POST", `/repos/${owner}/${repo}/deployments/${deployment_id}/statuses`, rest),
        createCommitStatus: ({ owner, repo, sha, ...rest }) =>
          call("POST", `/repos/${owner}/${repo}/statuses/${sha}`, rest),
      },
    },
  };
}
