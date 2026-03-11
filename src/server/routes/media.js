import { Router } from 'express';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

export function createMediaRouter() {
  const router = Router();

  // ── Pixabay search (images) ──
  router.get('/search/images', async (req, res) => {
    try {
      const { q, page = 1, type = 'photo', orientation = 'all', color = '' } = req.query;
      if (!q) return res.status(400).json({ error: 'q required' });

      const apiKey = process.env.PIXABAY_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'PIXABAY_API_KEY not configured. Get a free key at pixabay.com/api/' });

      const params = new URLSearchParams({
        key: apiKey,
        q,
        page: String(page),
        per_page: '24',
        image_type: type,
        orientation: orientation !== 'all' ? orientation : '',
        safesearch: 'true',
        lang: 'en',
      });
      if (color) params.set('colors', color);

      const resp = await fetch(`https://pixabay.com/api/?${params}`);
      const data = await resp.json();

      res.json({
        total: data.totalHits || 0,
        images: (data.hits || []).map(h => ({
          id: h.id,
          preview: h.webformatURL,
          full: h.largeImageURL,
          thumb: h.previewURL,
          width: h.imageWidth,
          height: h.imageHeight,
          tags: h.tags,
          source: 'pixabay',
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Pixabay search (videos) ──
  router.get('/search/videos', async (req, res) => {
    try {
      const { q, page = 1 } = req.query;
      if (!q) return res.status(400).json({ error: 'q required' });

      const apiKey = process.env.PIXABAY_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'PIXABAY_API_KEY not configured' });

      const params = new URLSearchParams({
        key: apiKey,
        q,
        page: String(page),
        per_page: '12',
        safesearch: 'true',
      });

      const resp = await fetch(`https://pixabay.com/api/videos/?${params}`);
      const data = await resp.json();

      res.json({
        total: data.totalHits || 0,
        videos: (data.hits || []).map(h => ({
          id: h.id,
          thumbnail: h.videos?.small?.thumbnail || '',
          url: h.videos?.medium?.url || h.videos?.small?.url || '',
          duration: h.duration,
          width: h.videos?.medium?.width || 0,
          height: h.videos?.medium?.height || 0,
          tags: h.tags,
          source: 'pixabay',
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── AI Image generation ──
  router.post('/generate/image', async (req, res) => {
    try {
      const { prompt, width = 1024, height = 1024, provider = 'openai' } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });

      let imageUrl = null;
      let imageBase64 = null;

      if (provider === 'openai') {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

        const resp = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: 'gpt-image-1',
            prompt,
            n: 1,
            size: mapOpenAISize(width, height),
            quality: 'medium',
          }),
        });

        const data = await resp.json();
        if (!resp.ok) return res.status(resp.status).json({ error: data.error?.message || 'Generation failed' });

        if (data.data?.[0]?.b64_json) {
          imageBase64 = data.data[0].b64_json;
        } else if (data.data?.[0]?.url) {
          imageUrl = data.data[0].url;
        }
      } else if (provider === 'replicate') {
        const apiKey = process.env.REPLICATE_API_TOKEN;
        if (!apiKey) return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured' });

        // Use Flux Schnell (fast, good quality)
        const resp = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            input: {
              prompt,
              num_outputs: 1,
              aspect_ratio: getAspectRatio(width, height),
            },
          }),
        });

        const prediction = await resp.json();
        if (!resp.ok) return res.status(resp.status).json({ error: prediction.detail || 'Generation failed' });

        // Poll for result
        const result = await pollReplicate(prediction.urls.get, apiKey);
        if (result.output?.[0]) {
          imageUrl = result.output[0];
        }
      }

      if (!imageUrl && !imageBase64) {
        return res.status(500).json({ error: 'No image generated' });
      }

      res.json({ imageUrl, imageBase64 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── AI Video generation ──
  router.post('/generate/video', async (req, res) => {
    try {
      const { prompt, duration = 5, provider = 'replicate' } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });

      let videoUrl = null;

      if (provider === 'replicate') {
        const apiKey = process.env.REPLICATE_API_TOKEN;
        if (!apiKey) return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured' });

        // Use Luma Ray Flash 2 for video generation
        const resp = await fetch('https://api.replicate.com/v1/models/luma/ray/predictions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            input: {
              prompt,
              duration: Math.min(duration, 10),
              aspect_ratio: '16:9',
            },
          }),
        });

        const prediction = await resp.json();
        if (!resp.ok) return res.status(resp.status).json({ error: prediction.detail || 'Generation failed' });

        // Poll for result (video takes longer)
        const result = await pollReplicate(prediction.urls.get, apiKey, 120);
        if (result.output) {
          videoUrl = typeof result.output === 'string' ? result.output : result.output[0];
        }
      }

      if (!videoUrl) return res.status(500).json({ error: 'No video generated' });
      res.json({ videoUrl });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Download media to project ──
  router.post('/download-to-project', async (req, res) => {
    try {
      const { url, base64, projectDir, filename, subdir = 'images' } = req.body;
      if (!projectDir || !filename) return res.status(400).json({ error: 'projectDir and filename required' });

      // Create assets directory
      const assetsDir = join(projectDir, 'assets', subdir);
      await mkdir(assetsDir, { recursive: true });

      const filePath = join(assetsDir, filename);

      if (base64) {
        const buffer = Buffer.from(base64, 'base64');
        await writeFile(filePath, buffer);
      } else if (url) {
        const resp = await fetch(url);
        if (!resp.ok) return res.status(500).json({ error: 'Failed to download' });
        const buffer = Buffer.from(await resp.arrayBuffer());
        await writeFile(filePath, buffer);
      } else {
        return res.status(400).json({ error: 'url or base64 required' });
      }

      res.json({
        ok: true,
        path: filePath,
        relativePath: `assets/${subdir}/${filename}`,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Check configured providers ──
  router.get('/providers', (req, res) => {
    res.json({
      pixabay: !!process.env.PIXABAY_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      replicate: !!process.env.REPLICATE_API_TOKEN,
    });
  });

  return router;
}

// ── Helpers ──

function mapOpenAISize(w, h) {
  if (w === h) return '1024x1024';
  if (w > h) return '1536x1024';
  return '1024x1536';
}

function getAspectRatio(w, h) {
  const r = w / h;
  if (r > 1.6) return '16:9';
  if (r > 1.2) return '3:2';
  if (r > 0.9) return '1:1';
  if (r > 0.6) return '2:3';
  return '9:16';
}

async function pollReplicate(url, apiKey, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await resp.json();

    if (data.status === 'succeeded') return data;
    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(data.error || 'Generation failed');
    }

    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Generation timed out');
}
