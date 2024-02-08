import { GoogleGenerativeAI, StartChatParams } from "@google/generative-ai";
import { program } from "commander";
import { config } from "dotenv";
import { flatten, unflatten } from "flat";
import path from "path";
import fs from "fs";
import { generateTranslation } from "./generate";
import Chats from "./interfaces/chats";
import {
    delay,
    getAllLanguageCodes,
    getLanguageFromCode,
    getLanguageFromFilename,
} from "./utils";
import TranslateFileOptions from "./interfaces/translate_file_options";
import TranslationOptions from "./interfaces/translate_options";

const BATCH_SIZE = 32;
const DEFAULT_TEMPLATED_STRING_PREFIX = "{{";
const DEFAULT_TEMPLATED_STRING_SUFFIX = "}}";

config({ path: path.resolve(__dirname, "../.env") });

program
    .requiredOption(
        "-i, --input <input>",
        "Source i18n file, in the jsons/ directory if a relative path is given",
    )
    .option(
        "-o, --output <output>",
        "Output i18n file, in the jsons/ directory if a relative path is given",
    )
    .option("-f, --force-language-name <language name>", "Force language name")
    .option("-A, --all-languages", "Translate to all supported languages")
    .option(
        "-l, --languages [language codes...]",
        "Pass a list of languages to translate to",
    )
    .option(
        "-p, --templated-string-prefix <prefix>",
        "Prefix for templated strings",
        DEFAULT_TEMPLATED_STRING_PREFIX,
    )
    .option(
        "-s, --templated-string-suffix <suffix>",
        "Suffix for templated strings",
        DEFAULT_TEMPLATED_STRING_SUFFIX,
    )
    .option("-k, --api-key", "Gemini API key");

const translateFile = async (options: TranslateFileOptions) => {
    const jsonFolder = path.resolve(__dirname, "../jsons");
    let inputPath: string;
    if (path.isAbsolute(options.inputFileOrPath)) {
        inputPath = path.resolve(options.inputFileOrPath);
    } else {
        inputPath = path.resolve(jsonFolder, options.inputFileOrPath);
    }

    let outputPath: string;
    if (path.isAbsolute(options.outputFileOrPath)) {
        outputPath = path.resolve(options.outputFileOrPath);
    } else {
        outputPath = path.resolve(jsonFolder, options.outputFileOrPath);
    }

    let inputJSON = {};
    try {
        const inputFile = fs.readFileSync(inputPath, "utf-8");
        inputJSON = JSON.parse(inputFile);
    } catch (e) {
        console.error(`Invalid JSON: ${e}`);
        return;
    }

    const inputLanguage = getLanguageFromFilename(
        options.inputFileOrPath,
    )?.name;
    if (!inputLanguage) {
        throw new Error(
            "Invalid input file name. Use a valid ISO 639-1 language code as the file name.",
        );
    }

    let outputLanguage = "";
    if (options.forceLanguageName) {
        outputLanguage = options.forceLanguageName;
    } else {
        const language = getLanguageFromFilename(
            options.outputFileOrPath,
        )?.name;
        if (!language) {
            throw new Error(
                "Invalid output file name. Use a valid ISO 639-1 language code as the file name. Consider using the --force-language option.",
            );
        }

        outputLanguage = language;
        if (!outputLanguage) {
            throw new Error(
                "Invalid output file name. Use a valid ISO 639-1 language code as the file name.",
            );
        }
    }

    try {
        const outputText = await translate({
            apiKey: options.apiKey,
            inputJSON,
            inputLanguage,
            outputLanguage,
            templatedStringPrefix: options.templatedStringPrefix,
            templatedStringSuffix: options.templatedStringSuffix,
        });

        fs.writeFileSync(outputPath, outputText);
    } catch (err) {
        console.error(`Failed to translate file to ${outputLanguage}: ${err}`);
    }
};

export async function translate(options: TranslationOptions): Promise<string> {
    console.log(
        `Translating from ${options.inputLanguage} to ${options.outputLanguage}...`,
    );

    const genAI = new GoogleGenerativeAI(options.apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    const successfulHistory: StartChatParams = { history: [] };
    const chats: Chats = {
        generateTranslationChat: model.startChat(),
        verifyTranslationChat: model.startChat(),
        verifyStylingChat: model.startChat(),
    };

    const output: { [key: string]: string } = {};

    const templatedStringPrefix =
        options.templatedStringPrefix || DEFAULT_TEMPLATED_STRING_PREFIX;
    const templatedStringSuffix =
        options.templatedStringSuffix || DEFAULT_TEMPLATED_STRING_SUFFIX;

    for (const key in options.inputJSON) {
        options.inputJSON[key] = options.inputJSON[key].replaceAll(
            "\\n",
            `${templatedStringPrefix}NEWLINE${templatedStringSuffix}`,
        );
    }

    const flatInput = flatten(options.inputJSON) as { [key: string]: string };

    // randomize flatInput ordering
    const allKeys = Object.keys(flatInput);
    for (let i = allKeys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allKeys[i], allKeys[j]] = [allKeys[j], allKeys[i]];
    }

    const batchStartTime = Date.now();
    for (let i = 0; i < Object.keys(flatInput).length; i += BATCH_SIZE) {
        if (i > 0) {
            console.log(
                `Completed ${((i / Object.keys(flatInput).length) * 100).toFixed(0)}%`,
            );
            console.log(
                `Estimated time left: ${((((Date.now() - batchStartTime) / (i + 1)) * (Object.keys(flatInput).length - i)) / 60000).toFixed(0)} minutes`,
            );
        }

        const keys = allKeys.slice(i, i + BATCH_SIZE);
        const input = keys.map((x) => `"${flatInput[x]}"`).join("\n");

        const generatedTranslation = await generateTranslation(
            model,
            chats,
            successfulHistory,
            `[${options.inputLanguage}]`,
            `[${options.outputLanguage}]`,
            input,
            keys,
            templatedStringPrefix,
            templatedStringSuffix,
        );

        if (generatedTranslation === "") {
            console.error(
                `Failed to generate translation for ${options.inputLanguage}`,
            );
            break;
        }

        for (let i = 0; i < keys.length; i++) {
            output[keys[i]] = generatedTranslation.split("\n")[i].slice(1, -1);
            console.log(
                `${keys[i]}:\n${flatInput[keys[i]]}\n=>\n${output[keys[i]]}\n`,
            );
        }
        const batchEndTime = Date.now();
        if (batchEndTime - batchStartTime < 3000) {
            console.log(
                `Waiting for ${3000 - (batchEndTime - batchStartTime)}ms...`,
            );
            await delay(3000 - (batchEndTime - batchStartTime));
        }
    }

    // sort the keys
    const sortedOutput: { [key: string]: string } = {};
    Object.keys(flatInput)
        .sort()
        .forEach((key) => {
            sortedOutput[key] = output[key];
        });

    const unflattenedOutput = unflatten(sortedOutput);
    const outputText = JSON.stringify(unflattenedOutput, null, 4).replaceAll(
        "{{NEWLINE}}",
        "\\n",
    );

    console.log(outputText);

    const endTime = Date.now();
    console.log(
        `Actual execution time: ${(endTime - batchStartTime) / 60000} minutes`,
    );

    return outputText;
}

(async () => {
    program.parse();
    const options = program.opts();

    if (!process.env.API_KEY && !options.apiKey) {
        console.error("API_KEY not found in .env file");
        return;
    }

    const apiKey = options.apiKey || process.env.API_KEY;

    if (!options.allLanguages && !options.languages) {
        if (!options.output) {
            console.error("Output file not specified");
            return;
        }

        await translateFile({
            apiKey,
            inputFileOrPath: options.input,
            outputFileOrPath: options.output,
            forceLanguageName: options.forceLanguageName,
            templatedStringPrefix: options.templatedStringPrefix,
            templatedStringSuffix: options.templatedStringSuffix,
        });
    } else if (options.languages) {
        if (options.forceLanguageName) {
            console.error("Cannot use both --languages and --force-language");
            return;
        }

        if (options.allLanguages) {
            console.error("Cannot use both --all-languages and --languages");
            return;
        }

        if (options.languages.length === 0) {
            console.error("No languages specified");
            return;
        }

        const languageNames = options.languages
            .map((x: string) => getLanguageFromCode(x)?.name)
            .filter((x: string | undefined) => x) as string[];
        console.log(`Translating to ${languageNames.join(", ")}...`);

        let i = 0;
        for (const languageCode of options.languages) {
            i++;
            console.log(
                `Translating ${i}/${options.languages.length} languages...`,
            );
            const output = options.input.replace(
                getLanguageFromFilename(options.input)?.iso639_1,
                languageCode,
            );

            if (options.input === output) {
                continue;
            }

            try {
                await translateFile({
                    apiKey,
                    inputFileOrPath: options.input,
                    outputFileOrPath: output,
                    templatedStringPrefix: options.templatedStringPrefix,
                    templatedStringSuffix: options.templatedStringSuffix,
                });
            } catch (err) {
                console.error(`Failed to translate to ${languageCode}: ${err}`);
            }
        }
    } else {
        if (options.forceLanguageName) {
            console.error(
                "Cannot use both --all-languages and --force-language",
            );
            return;
        }

        console.warn(
            "Some languages may fail to translate due to the model's limitations",
        );

        let i = 0;
        for (const languageCode of getAllLanguageCodes()) {
            i++;
            console.log(
                `Translating ${i}/${getAllLanguageCodes().length} languages...`,
            );
            const output = options.input.replace(
                getLanguageFromFilename(options.input)?.iso639_1,
                languageCode,
            );

            if (options.input === output) {
                continue;
            }

            try {
                await translateFile({
                    apiKey,
                    inputFileOrPath: options.input,
                    outputFileOrPath: output,
                    templatedStringPrefix: options.templatedStringPrefix,
                    templatedStringSuffix: options.templatedStringSuffix,
                });
            } catch (err) {
                console.error(`Failed to translate to ${languageCode}: ${err}`);
            }
        }
    }
})();
