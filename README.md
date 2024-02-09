# `i18n-ai-translate`

Use [Gemini Pro](https://ai.google.dev/) to translate your i18n JSON to any language.

Chains three prompts to ensure each translation is well-formed. History is retained between calls to ensure consistency when translating the entire file.

## Usage
Use `npm run convert` to run this as a script to convert a local i18n JSON file to any language. Relative paths begin from the `jsons/` directory.

Create a `.env` file with an entry `API_KEY=<your Gemini API key>`, or pass the `--api-key` flag.

```
Usage: npm run convert -- [options]

Options:
  -i, --input <input>                        Source i18n file, in the jsons/ directory if a relative path is given
  -o, --output <output>                      Output i18n file, in the jsons/ directory if a relative path is given
  -f, --force-language-name <language name>  Force language name
  -A, --all-languages                        Translate to all supported languages
  -l, --languages [language codes...]        Pass a list of languages to translate to
  -p, --templated-string-prefix <prefix>     Prefix for templated strings (default: "{{")
  -s, --templated-string-suffix <suffix>     Suffix for templated strings (default: "}}")
  -k, --api-key                              Gemini API key
  --verbose                                  Print logs about progress (default: false)
  -h, --help                                 display help for command
```

### Example usage
`npm run convert -- -i en.json -o fr.json` -- Translate the `en.json` file in `jsons/` to French, and save the output in `fr.json`

`npm run convert -- -i en.json -l es de nl` -- Translate the `en.json` file in `jsons/` to Spanish, German, and Dutch, and save each file in `jsons/`

### As a library
Alternatively, import this project and use it to convert JSONs on-the-fly with `translate()`, or use `translateDiff()` to fetch updates to modified keys when your source i18n file has changed.

```ts
import { translate, translateDiff } from "i18n-ai-translate";

...

const translation = await translate({
    apiKey, // Gemini API key
    inputJSON, // JSON to translate
    inputLanguage, // Language of inputJSON
    outputLanguage, // Targeted language (e.g. French, Spanish, etc.)
    templatedStringPrefix, // The start of inline variables; defaults to "{{"
    templatedStringSuffix, // The end of inline variables; defaults to "}}"
    verbose, // Print status of conversion to stdout/stderr
});

const translations = await translateDiff({
    apiKey, // Gemini API key
    inputLanguage, // Language of inputJSONBefore/After
    inputJSONBefore, // The source translation before a change
    inputJSONAfter, // The source translation after a change
    inputLanguage, // Language of inputJSONBefore/After
    toUpdateJSONs, // An object of language names to their translations
    templatedStringPrefix, // The start of inline variables; defaults to "{{"
    templatedStringSuffix, // The end of inline variables; defaults to "}}"
    verbose, // Print status of conversion to stdout/stderr
});
```


## Translation prompt
Batches of the i18n input are passed in. Each call is checked to ensure no keys are lost, all templated strings are retained, and no translations were skipped.
```
You are a professional translator.

Translate each line from ${inputLanguage} to ${outputLanguage}.

Return translations in the same text formatting.

Maintain case sensitivity and whitespacing.

Output only the translations.

All lines should start and end with a quotation mark.

\`\`\`
${input}
\`\`\`
```

## Translation verification prompt
The output of the translation is sent back to ensure the model is okay with the translation. If this fails, the translation is re-generated.
```
Given a translation from ${inputLanguage} to ${outputLanguage} in CSV form, reply with NAK if _any_ of the translations are poorly translated. Otherwise, reply with ACK. Only reply with ACK/NAK.

**Be as nitpicky as possible.** If even the smallest thing seems off, you should reply NAK.

\`\`\`
${inputLanguage},${outputLanguage}
${mergedCsv}
\`\`\`
```

## Styling verification prompt
Formatting from the input should be retained where possible. If punctuation, capitalization, or whitespaces differ between the source and the translation, the translation should be re-generated.
```
Given text from ${inputLanguage} to ${outputLanguage} in CSV form, reply with NAK if _any_ of the translations do not match the formatting of the original. Check for differing capitalization, punctuation, or whitespaces. Otherwise, reply with ACK. Only reply with ACK/NAK.

**Be as nitpicky as possible.** If even the smallest thing seems off, you should reply NAK.

\`\`\`
${inputLanguage},${outputLanguage}
${mergedCsv}
\`\`\`
```
