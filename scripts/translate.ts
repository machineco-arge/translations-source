import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// --- CONFIGURATION ---
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const DEEPL_API_URL_FREE = 'https://api-free.deepl.com/v2/translate';
const GOOGLE_API_URL = `https://translation.googleapis.com/language/translate/v2`;

const DEEPL_SUPPORTED_TARGET_LANGS = new Set([
  'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr',
  'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'nb', 'nl', 'pl', 'pt',
  'ro', 'ru', 'sk', 'sl', 'sv', 'uk', 'zh'
]);
const BASE_LANGUAGE = 'tr';

// All supported languages by the application, from TranslationService.ts
const ALL_SUPPORTED_LANGUAGES = [
  'en', 'az', 'de', 'es', 'fr', 'it', 'pt', 'ru', 'ja', 'ko', 'zh', 'ar'
];

// --- PLACEHOLDER HANDLING LOGIC (from TranslationService.ts) ---

function extractPlaceholders(text: string): { textWithMarkers: string; placeholderMap: Map<string, string> } {
  const placeholderRegex = /\{\{?\w+\}?\}/g;
  const placeholders = text.match(placeholderRegex) || [];
  if (placeholders.length === 0) {
    return { textWithMarkers: text, placeholderMap: new Map() };
  }
  let textWithMarkers = text;
  const placeholderMap = new Map<string, string>();
  placeholders.forEach((placeholder, index) => {
    const marker = `XPLACEHOLDERX${index}XPLACEHOLDERX`;
    placeholderMap.set(marker, placeholder);
    textWithMarkers = textWithMarkers.replace(placeholder, ` ${marker} `);
  });
  return { textWithMarkers, placeholderMap };
}

function restorePlaceholders(translatedText: string, placeholderMap: Map<string, string>): string {
  if (placeholderMap.size === 0) return translatedText;
  let result = translatedText;
  for (const [marker, placeholder] of placeholderMap.entries()) {
    const markerVariations = [
      marker, marker.toLowerCase(), marker.toUpperCase(), marker.replace(/X/g, 'x'),
      marker.substring(0, marker.length - 1), marker.substring(1),
    ];
    for (const variation of markerVariations) {
      const escapedMarker = variation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\s*${escapedMarker}\\s*`, 'gi');
      if (regex.test(result)) {
        result = result.replace(regex, ` ${placeholder} `);
        break;
      }
    }
  }
  return result.replace(/\s+/g, ' ').trim();
}

// --- Pre-processing Function ---
function preprocessTextsForTranslation(texts: string[]): {
  processedTexts: string[];
  placeholderMaps: Map<string, string>[];
} {
  const processedTexts: string[] = [];
  const placeholderMaps: Map<string, string>[] = [];
  texts.forEach(text => {
    const { textWithMarkers, placeholderMap } = extractPlaceholders(text);
    processedTexts.push(textWithMarkers);
    placeholderMaps.push(placeholderMap);
  });
  return { processedTexts, placeholderMaps };
}

// --- API HELPER FUNCTIONS ---

async function translateWithDeepL(texts: string[], targetLang: string): Promise<string[]> {
  if (!DEEPL_API_KEY) throw new Error('DeepL API key is missing. Please check your .env file.');
  
  const { processedTexts, placeholderMaps } = preprocessTextsForTranslation(texts);

  const formData = new URLSearchParams();
  formData.append('auth_key', DEEPL_API_KEY);
  formData.append('source_lang', BASE_LANGUAGE.toUpperCase());
  
  let deepLTargetLang = targetLang.toUpperCase();
  if (targetLang.toLowerCase() === 'en') deepLTargetLang = 'EN-US';
  if (targetLang.toLowerCase() === 'pt') deepLTargetLang = 'PT-PT';
  formData.append('target_lang', deepLTargetLang);
  
  processedTexts.forEach(text => formData.append('text', text));

  try {
    const response = await axios.post(DEEPL_API_URL_FREE, formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'PhotoApp/1.0',
      },
      timeout: 30000,
    });
    const translatedTexts = response.data.translations.map((t: any) => t.text);
    return translatedTexts.map((text: string, index: number) => restorePlaceholders(text, placeholderMaps[index]));
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      if (error.response.status === 456 || error.response.status === 429) {
        throw new Error(`DeepL quota exceeded (HTTP ${error.response.status}).`);
      }
      throw new Error(`DeepL API Error: ${error.response.status} - ${JSON.stringify(error.response.data, null, 2)}`);
    }
    throw error;
  }
}

async function translateWithGoogle(texts: string[], targetLang: string): Promise<string[]> {
  if (!GOOGLE_API_KEY) throw new Error('Google API key is missing. Please check your .env file.');

  const { processedTexts, placeholderMaps } = preprocessTextsForTranslation(texts);

  try {
    const response = await axios.post(`${GOOGLE_API_URL}?key=${GOOGLE_API_KEY}`, {
      q: processedTexts,
      source: BASE_LANGUAGE,
      target: targetLang,
      format: 'text',
    }, {
      timeout: 30000,
    });
    
    const translatedTexts = response.data.data.translations.map((t: any) => t.translatedText);
    return translatedTexts.map((text: string, index: number) => restorePlaceholders(text, placeholderMaps[index]));
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      throw new Error(`Google Translate API Error: ${error.response.status} - ${JSON.stringify(error.response.data, null, 2)}`);
    }
    throw error;
  }
}

// --- MAIN SCRIPT LOGIC ---

async function run() {
  const argv = await yargs(hideBin(process.argv))
    .option('source', { alias: 's', type: 'string', description: 'Source JSON file path', demandOption: true })
    .option('output', { alias: 'o', type: 'string', description: 'Base output directory for translated files', demandOption: true })
    .option('languages', {
      alias: 'l',
      type: 'string',
      description: 'Optional: Comma-separated list of target language codes (e.g., en,de,az). If not provided, all supported languages will be translated.',
    })
    .help().argv;

  console.log(`Starting translation process...`);
  console.log(`   - Source File: ${argv.source}`);
  console.log(`   - Output Dir:  ${argv.output}`);

  try {
    const sourceContent = await fs.readFile(argv.source, 'utf-8');
    const sourceJson = JSON.parse(sourceContent);
    const sourceKeys = Object.keys(sourceJson);
    const sourceTexts = Object.values(sourceJson) as string[];

    const targetLanguages = argv.languages ? argv.languages.split(',') : ALL_SUPPORTED_LANGUAGES;
    const namespace = path.basename(argv.source, '.json');

    console.log(`   - Namespace:   ${namespace}`);
    console.log(`   - Languages:   ${targetLanguages.join(', ')}`);

    for (const lang of targetLanguages) {
      const outputDir = path.resolve(argv.output, namespace);
      await fs.mkdir(outputDir, { recursive: true });

      if (lang.toLowerCase() === BASE_LANGUAGE) {
        const outputPath = path.join(outputDir, `${lang}.json`);
        await fs.copyFile(argv.source, outputPath);
        console.log(`Source language '${BASE_LANGUAGE}' copied to dist.`);
        continue;
      }
      console.log(`\nTranslating to ${lang.toUpperCase()}...`);

      const outputPath = path.join(outputDir, `${lang}.json`);
      let existingTranslations: { [key: string]: string } = {};

      try {
        const existingContent = await fs.readFile(outputPath, 'utf-8');
        existingTranslations = JSON.parse(existingContent);
        console.log(`   - Found existing translations for ${lang.toUpperCase()}.`);
      } catch (error) {
        // File doesn't exist, which is fine.
      }

      const keysToTranslate: string[] = [];
      const textsToTranslate: string[] = [];
      const finalTranslations: { [key: string]: string } = { ...existingTranslations };

      sourceKeys.forEach((key, index) => {
        if (!existingTranslations[key]) {
          keysToTranslate.push(key);
          textsToTranslate.push(sourceTexts[index]);
        }
      });
      
      if (textsToTranslate.length === 0) {
        console.log(`All keys already translated for ${lang.toUpperCase()}. Nothing to do.`);
        // Ensure the final file has the same key order as the source
        const reorderedJson: { [key: string]: string } = {};
        sourceKeys.forEach(key => {
            if (finalTranslations[key]) {
                reorderedJson[key] = finalTranslations[key];
            }
        });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(outputPath, JSON.stringify(reorderedJson, null, 2), 'utf-8');
        continue;
      }

      console.log(`   - Found ${textsToTranslate.length} new key(s) to translate.`);
      let translatedTexts: string[];

      if (DEEPL_SUPPORTED_TARGET_LANGS.has(lang.toLowerCase())) {
        try {
          console.log(`   - Using primary service: DeepL`);
          translatedTexts = await translateWithDeepL(textsToTranslate, lang);
        } catch (error) {
          console.warn(`   - DeepL failed: ${(error as Error).message}`);
          console.log(`   - Using fallback service: Google Cloud Translate`);
          translatedTexts = await translateWithGoogle(textsToTranslate, lang);
        }
      } else {
        console.log(`   - Language '${lang}' not directly supported by DeepL. Using Google Cloud Translate.`);
        translatedTexts = await translateWithGoogle(textsToTranslate, lang);
      }

      keysToTranslate.forEach((key, index) => {
        finalTranslations[key] = translatedTexts[index];
      });

      // Re-order the final JSON to match the source file's key order
      const finalOrderedJson: { [key: string]: string } = {};
      sourceKeys.forEach(key => {
        if (finalTranslations[key]) {
            finalOrderedJson[key] = finalTranslations[key];
        }
      });

      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(outputPath, JSON.stringify(finalOrderedJson, null, 2), 'utf-8');
      console.log(`Successfully updated and saved translation to ${outputPath}`);
    }

    console.log('\nAll translations completed successfully!');
  } catch (error) {
    console.error('\nAn error occurred during the translation process:', (error as Error).message);
    process.exit(1);
  }
}

run(); 