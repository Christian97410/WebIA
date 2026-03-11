import { Router } from 'express';
import simpleGit from 'simple-git';

export function createGitRouter() {
  const router = Router();

  // Get git status (branch, modified, staged)
  router.get('/status', async (req, res) => {
    try {
      const { dir } = req.query;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const git = simpleGit(dir);
      const status = await git.status();
      res.json({
        branch: status.current,
        modified: status.modified,
        staged: status.staged,
        not_added: status.not_added,
        conflicted: status.conflicted,
        created: status.created,
        deleted: status.deleted,
        renamed: status.renamed,
        isClean: status.isClean(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get diff of uncommitted changes
  router.get('/diff', async (req, res) => {
    try {
      const { dir } = req.query;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const git = simpleGit(dir);
      const diff = await git.diff();
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stage all changes and commit
  router.post('/commit', async (req, res) => {
    try {
      const { dir, message } = req.body;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      if (!message) return res.status(400).json({ error: 'message required' });
      const git = simpleGit(dir);
      await git.add('.');
      const result = await git.commit(message);
      res.json({
        ok: true,
        commit: result.commit,
        summary: {
          changes: result.summary.changes,
          insertions: result.summary.insertions,
          deletions: result.summary.deletions,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get current branch name
  router.get('/branch', async (req, res) => {
    try {
      const { dir } = req.query;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const git = simpleGit(dir);
      const branch = await git.branchLocal();
      res.json({ current: branch.current, branches: branch.all });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
