import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

const CSV_PATH = fileURLToPath(new URL('./products.csv', import.meta.url));
const PROMPT_PATH = fileURLToPath(new URL('./system-prompt.txt', import.meta.url));
const MODEL = 'claude-sonnet-5-5';
const REQUIRED_COLUMNS = ['name', 'description', 'price'];

dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)), quiet: true });

// Minimal RFC 4180 parser: handles quoted fields, escaped quotes, commas and newlines in quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export async function readProducts(path = CSV_PATH) {
  const text = (await readFile(path, 'utf8')).replace(/^﻿/, '');
  const [header, ...rows] = parseCsv(text).filter((r) => r.some((c) => c !== ''));
  if (!header) throw new Error(`${path} is empty.`);

  const columns = header.map((col) => col.trim());
  const missing = REQUIRED_COLUMNS.filter((col) => !columns.includes(col));
  if (missing.length) throw new Error(`${path} is missing column(s): ${missing.join(', ')}`);

  const products = [];
  rows.forEach((cells, i) => {
    const line = i + 2; // header is line 1
    if (cells.length !== columns.length) {
      console.warn(`Skipping line ${line}: expected ${columns.length} fields, found ${cells.length}.`);
      return;
    }
    const product = Object.fromEntries(columns.map((col, j) => [col, cells[j]]));
    if (!product.name.trim()) {
      console.warn(`Skipping line ${line}: missing name.`);
      return;
    }
    products.push(product);
  });
  return products;
}

// Tokens starting with a digit (40L, 1L) are treated as units and kept uppercase.
function toTitleCase(str) {
  return str
    .split(' ')
    .map((word) =>
      /^\d/.test(word)
        ? word.toUpperCase()
        : word.toLowerCase().replace(/(^|-)(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase()),
    )
    .join(' ');
}

export function cleanProduct(product) {
  const name = product.name.trim().replace(/\s+/g, ' ');
  return {
    name: toTitleCase(name),
    description: product.description.trim(),
    price: product.price.trim(),
  };
}

async function loadSystemPrompt() {
  const prompt = (await readFile(PROMPT_PATH, 'utf8')).trim();
  if (!prompt) throw new Error('system-prompt.txt is empty; paste the system prompt into it.');
  return prompt;
}

// Pulls the "description" field out of the model's JSON reply, tolerating code fences or extra prose.
function extractDescription(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`No JSON object in response: ${text}`);
  const { description } = JSON.parse(text.slice(start, end + 1));
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`Response JSON has no "description" string: ${text}`);
  }
  return description.trim();
}

export async function fillMissingDescriptions(products) {
  if (!products.some((p) => !p.description)) return products;

  const system = await loadSystemPrompt();
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY

  return Promise.all(
    products.map(async (product) => {
      if (product.description) return product;
      try {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 1024,
          system,
          messages: [
            { role: 'user', content: JSON.stringify({ name: product.name, price: product.price }) },
          ],
        });
        const text = response.content.find((block) => block.type === 'text')?.text ?? '';
        return { ...product, description: extractDescription(text) };
      } catch (err) {
        console.warn(`Could not generate a description for "${product.name}": ${err.message}`);
        return product;
      }
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const products = await fillMissingDescriptions((await readProducts()).map(cleanProduct));
    console.table(products);
  } catch (err) {
    console.error(err.code === 'ENOENT' ? `File not found: ${err.path}` : err.message);
    process.exitCode = 1;
  }
}
