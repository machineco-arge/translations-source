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

// --- UTILITY FUNCTIONS for nested JSON ---

function flattenObject(obj: any, prefix: string = ''): { [key: string]: any } {
  const result: { [key: string]: any } = {};

  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      const value = obj[key];

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(result, flattenObject(value, newKey));
      } else {
        result[newKey] = value;
      }
    }
  }
  return result;
}

function unflattenObject(obj: { [key: string]: any }): any {
  if (Object.keys(obj).length === 0) return {};
  const result: any = {};

  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      const keys = key.split('.');
      keys.reduce((acc, currentKey, index) => {
        if (index === keys.length - 1) {
          acc[currentKey] = obj[key];
        } else {
          acc[currentKey] = acc[currentKey] || {};
        }
        return acc[currentKey];
      }, result);
    }
  }
  return result;
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

async function translateWithDeepL(texts: string[], targetLang: string): Promise<string[] | null> {
  if (!DEEPL_API_KEY) {
    console.warn('DeepL API key is missing. Cannot use DeepL service.');
    return null;
  }
  
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
        console.warn(`DeepL quota exceeded (HTTP ${error.response.status}). Will attempt fallback.`);
      } else {
        console.error(`DeepL API Error: ${error.response.status} - ${JSON.stringify(error.response.data, null, 2)}`);
      }
    } else {
      console.error('An unknown error occurred in translateWithDeepL:', error);
    }
    return null;
  }
}

async function translateWithGoogle(texts: string[], targetLang: string): Promise<string[] | null> {
  if (!GOOGLE_API_KEY) {
    // This function should only be called if the key exists, but as a safeguard:
    console.warn('Google API key is missing. Cannot use Google Translate service.');
    return null;
  }

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
      const errorMessage = error.response.data?.error?.message || JSON.stringify(error.response.data);
      console.error(`Google Translate API Error: ${error.response.status} - ${errorMessage}`);
    } else {
      console.error('An unknown error occurred in translateWithGoogle:', error);
    }
    return null;
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
    const flatSourceJson = flattenObject(sourceJson);
    const sourceKeys = Object.keys(flatSourceJson);

    const targetLanguages = argv.languages ? argv.languages.split(',') : ALL_SUPPORTED_LANGUAGES;

    console.log(`   - Languages:   ${targetLanguages.join(', ')}`);

    for (const lang of targetLanguages) {
      // The output path is now directly the output directory + lang.json
      // The namespace is handled by the overall folder structure defined in the package.json script
      const outputPath = path.resolve(argv.output, `${lang}.json`);
      const outputDir = path.dirname(outputPath);
      await fs.mkdir(outputDir, { recursive: true });

      if (lang.toLowerCase() === BASE_LANGUAGE) {
        // Source file is already at the root of the namespace, just copy to output
        await fs.copyFile(argv.source, outputPath);
        console.log(`Source language '${BASE_LANGUAGE}' copied to ${outputPath}.`);
        continue;
      }
      console.log(`\nTranslating to ${lang.toUpperCase()}...`);

      let existingTranslations: { [key: string]: any } = {};

      try {
        const existingContent = await fs.readFile(outputPath, 'utf-8');
        existingTranslations = flattenObject(JSON.parse(existingContent));
        console.log(`   - Found existing translations for ${lang.toUpperCase()}.`);
      } catch (error) {
        // File doesn't exist, which is fine.
      }

      const keysToTranslate: string[] = [];
      const textsToTranslate: string[] = [];
      const finalTranslations: { [key: string]: any } = { ...existingTranslations };

      sourceKeys.forEach(key => {
        // If the key is already in the destination file, skip it.
        if (finalTranslations.hasOwnProperty(key)) {
          return;
        }

        const value = flatSourceJson[key];

        // If the source value is a string, add it to the list for translation.
        if (typeof value === 'string') {
          keysToTranslate.push(key);
          textsToTranslate.push(value);
        } else {
          // If it's not a string (number, boolean, null), copy it directly.
          console.log(`   - Copying non-string value for key '${key}'.`);
          finalTranslations[key] = value;
        }
      });
      
      if (textsToTranslate.length === 0) {
        console.log(`All keys already translated or copied for ${lang.toUpperCase()}. Nothing to do.`);
        // Ensure the final file has the same key order as the source
        const reorderedFlatJson: { [key: string]: any } = {};
        sourceKeys.forEach(key => {
            if (finalTranslations[key] !== undefined) {
                reorderedFlatJson[key] = finalTranslations[key];
            }
        });
        const reorderedNestedJson = unflattenObject(reorderedFlatJson);
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(outputPath, JSON.stringify(reorderedNestedJson, null, 2), 'utf-8');
        continue;
      }

      console.log(`   - Found ${textsToTranslate.length} new string key(s) to translate.`);
      let translatedTexts: string[] | null = null;

      if (DEEPL_SUPPORTED_TARGET_LANGS.has(lang.toLowerCase())) {
        console.log(`   - Using primary service: DeepL`);
        translatedTexts = await translateWithDeepL(textsToTranslate, lang);
        
        // If DeepL fails (returns null) and a Google key exists, try the fallback.
        if (!translatedTexts && GOOGLE_API_KEY) {
          console.log(`   - DeepL failed. Using fallback service: Google Cloud Translate`);
          translatedTexts = await translateWithGoogle(textsToTranslate, lang);
        }
      } else {
        // Language not supported by DeepL, try Google directly if the key exists.
        if (GOOGLE_API_KEY) {
          console.log(`   - Language '${lang}' not directly supported by DeepL. Using Google Cloud Translate.`);
          translatedTexts = await translateWithGoogle(textsToTranslate, lang);
        } else {
          // Not supported by DeepL and no Google key, so we must skip.
          console.warn(`   - SKIPPING ${lang.toUpperCase()}: Language not supported by DeepL and no Google API key is available.`);
        }
      }
      
      // If after all attempts, we still have no translations, skip to the next language.
      if (!translatedTexts) {
        console.log(`   - Could not generate translation for ${lang.toUpperCase()}. Continuing to next language.`);
        continue;
      }

      keysToTranslate.forEach((key, index) => {
        finalTranslations[key] = translatedTexts[index];
      });

      // Re-order the final JSON to match the source file's key order
      const finalOrderedFlatJson: { [key: string]: any } = {};
      sourceKeys.forEach(key => {
        if (finalTranslations[key] !== undefined) {
            finalOrderedFlatJson[key] = finalTranslations[key];
        }
      });

      const finalNestedJson = unflattenObject(finalOrderedFlatJson);

      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(outputPath, JSON.stringify(finalNestedJson, null, 2), 'utf-8');
      console.log(`Successfully updated and saved translation to ${outputPath}`);
    }

    console.log('\nAll translations completed successfully!');
  } catch (error) {
    console.error('\nAn error occurred during the translation process:', (error as Error).message);
    process.exit(1);
  }
}

run(); 