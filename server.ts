import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VALID_COLORS = new Set(['W', 'Y', 'G', 'B', 'R', 'O']);
const VALID_FACES = new Set(['U', 'D', 'F', 'B', 'R', 'L']);

interface UploadedCubeImage {
  slot: string;
  dataUrl: string;
  faces: string[];
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function createAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY nije podešen na serveru (proverite Settings > Secrets panel).');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function buildFacePrompt(slot: string, faces: string[]): string {
  const faceList = faces.join(', ');
  if (faces.length === 3 && faces[0] === 'U' && faces[1] === 'F' && faces[2] === 'R') {
    return [
      `This image (${slot}) shows 3 faces of a 3x3x3 Rubik's Cube from an isometric top-front-right angle:`,
      '- U (Top face): row-major order top-to-bottom (back edge to front edge), left-to-right (L side to R side). Row 2 (indices 6,7,8) touches the top edge of F; Col 2 (indices 2,5,8) touches the top edge of R.',
      '- F (Front-left face in image): row-major order top-to-bottom (touching U at row 0), left-to-right (touching R at col 2).',
      '- R (Front-right face in image): row-major order top-to-bottom (touching U at row 0), left-to-right (touching F at col 0, toward back at col 2).',
      `Return ONLY the 3 faces [${faceList}], each as an array of 9 single-letter color codes from ["W","Y","G","B","R","O"] (W=White, Y=Yellow, G=Green, B=Blue, R=Red, O=Orange).`,
    ].join('\n');
  }

  if (faces.length === 3 && faces[0] === 'D' && faces[1] === 'B' && faces[2] === 'L') {
    return [
      `This image (${slot}) shows the remaining 3 faces of the same 3x3x3 Rubik's Cube (D=Bottom, B=Back, L=Left):`,
      '- Look carefully at which face is on top vs front-left vs front-right in this photo.',
      '- Return each face in its standard 3x3 row-major orientation (9 stickers, indices 0..8):',
      '  * D (Bottom face when viewed directly): row 0 touches F, row 2 touches B, col 0 touches L, col 2 touches R.',
      '  * B (Back face when viewed directly from behind): row 0 touches U, row 2 touches D, col 0 touches R, col 2 touches L.',
      '  * L (Left face when viewed directly from the left): row 0 touches U, row 2 touches D, col 0 touches B, col 2 touches F.',
      `Return ONLY the 3 faces [${faceList}], each as an array of 9 single-letter color codes from ["W","Y","G","B","R","O"] (W=White, Y=Yellow, G=Green, B=Blue, R=Red, O=Orange).`,
    ].join('\n');
  }

  return [
    `This image (${slot}) shows faces [${faceList}] of a 3x3x3 Rubik's Cube.`,
    'For each requested face, read its 3x3 grid in row-major order (9 stickers, top-to-bottom, left-to-right) using codes ["W","Y","G","B","R","O"] (W=White, Y=Yellow, G=Green, B=Blue, R=Red, O=Orange).',
  ].join('\n');
}

async function analyzeSingleImage(ai: GoogleGenAI, img: UploadedCubeImage) {
  const parsed = parseDataUrl(img.dataUrl);
  if (!parsed) {
    throw new Error('Neispravan format slike. Podržani su PNG, JPEG i WEBP.');
  }

  const requestedFaces = img.faces.filter((f) => VALID_FACES.has(f));
  if (requestedFaces.length === 0) {
    throw new Error('Nije izabrana nijedna validna strana kocke za očitavanje.');
  }

  const faceProperties: Record<string, object> = {};
  for (const f of requestedFaces) {
    faceProperties[f] = {
      type: Type.ARRAY,
      description: `9 sticker color codes (row-major 3x3) for face ${f}: W, Y, G, B, R, or O.`,
      items: { type: Type.STRING },
    };
  }

  const retryCall = async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: parsed.mimeType,
                  data: parsed.data,
                },
              },
              {
                text: buildFacePrompt(img.slot, requestedFaces),
              },
            ],
          },
          config: {
            systemInstruction:
              'You are a precision Rubik\'s cube computer vision parser. Carefully distinguish Orange (O) vs Red (R), White (W) vs Yellow (Y), and Green (G) vs Blue (B) accounting for shadows and reflections. Always output exactly 9 single-letter codes per requested face.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                faces: {
                  type: Type.OBJECT,
                  properties: faceProperties,
                  required: requestedFaces,
                },
                notes: {
                  type: Type.STRING,
                  description: 'Optional short warning in Serbian if lighting or angle caused uncertainty.',
                },
              },
              required: ['faces'],
            },
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        });
      } catch (err: unknown) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const transient = /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(msg);
        if (!transient || attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 600 * Math.pow(2, attempt)));
      }
    }
    throw lastErr;
  };

  const response = await retryCall();

  const rawText = (response.text ?? '{}').trim();
  const decoded = JSON.parse(rawText) as { faces?: Record<string, string[]>; notes?: string };
  const outFaces: Record<string, string[]> = {};

  for (const f of requestedFaces) {
    const arr = decoded.faces?.[f];
    if (!Array.isArray(arr) || arr.length !== 9) {
      throw new Error(`Model nije očitao tačno 9 polja za stranu ${f}.`);
    }
    outFaces[f] = arr.map((c) => {
      const upper = String(c || '').trim().toUpperCase()[0] || 'W';
      return VALID_COLORS.has(upper) ? upper : 'W';
    });
  }

  return { faces: outFaces, notes: decoded.notes || '' };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  app.post('/api/cube/recognize', async (req, res) => {
    try {
      const body = req.body as { images?: UploadedCubeImage[] };
      const images = Array.isArray(body?.images) ? body.images : [];
      if (images.length === 0 || images.length > 2) {
        res.status(400).json({ error: 'Pošaljite 1 ili 2 slike kocke za prepoznavanje.' });
        return;
      }

      const ai = createAiClient();
      const mergedFaces: Record<string, string[]> = {};
      const notes: string[] = [];

      const results = await Promise.all(images.map((img) => analyzeSingleImage(ai, img)));
      for (const r of results) {
        Object.assign(mergedFaces, r.faces);
        if (r.notes) notes.push(r.notes);
      }

      res.json({ faces: mergedFaces, notes: notes.join(' ').trim() });
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : 'Greška pri analizi slike.';
      if (/GEMINI_API_KEY|API_KEY_INVALID|PERMISSION_DENIED/i.test(raw)) {
        res.status(500).json({ error: 'API ključ nije podešen ili nije validan (proverite Settings > Secrets panel).' });
        return;
      }
      if (/503|UNAVAILABLE|high demand/i.test(raw)) {
        res.status(503).json({ error: 'AI servis je trenutno preopterećen. Pokušajte ponovo za nekoliko sekundi ili unesite boje ručno na mreži.' });
        return;
      }
      if (/429|RESOURCE_EXHAUSTED/i.test(raw)) {
        res.status(429).json({ error: 'Dostignuto je ograničenje zahteva. Sačekajte trenutak i pokušajte ponovo.' });
        return;
      }
      res.status(400).json({ error: raw });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      const distIndex = path.join(distDir, 'index.html');
      if (fs.existsSync(distIndex)) {
        res.sendFile(distIndex);
      } else {
        res.status(404).send('Build not found');
      }
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`ChronoCube 3D server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
