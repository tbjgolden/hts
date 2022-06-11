import fs from "node:fs";
import path from "node:path/posix";
import { transform } from "sucrase";
import { fork } from "node:child_process";
import { getDependencies } from "./dependencies.mjs";
import { updateImports } from "./update-imports.mjs";
import { determineModuleTypeFromString } from "./determine-module-type.mjs";

/**
 * Convert source code from an entry file into a directory of node-friendly esm code
 * @param {string} entryFilePath
 * @param {string | undefined} outputDirectory @default path.join(process.cwd(), ".jbuild")
 * @returns {Promise<string | undefined>} outputEntryFilePath
 */
export const build = async (
  entryFilePath,
  outputDirectory = path.join(process.cwd(), ".jbuild")
) => {
  const firstFilePath = path.resolve(process.cwd(), entryFilePath);

  const firstFileParsedString = await sucrase(firstFilePath);

  const fileStack = [
    [
      firstFilePath,
      path.extname(firstFilePath) || ".js",
      determineModuleTypeFromString(firstFileParsedString),
    ],
  ];
  let shortPath;
  const explored = new Map();
  while (true) {
    const next = fileStack.pop();
    if (next === undefined) break;

    const [rawFilePath, impliedExtension, isESM] = next;
    const filePath = path.extname(rawFilePath)
      ? rawFilePath
      : rawFilePath + impliedExtension;

    if (!explored.has(filePath)) {
      explored.set(filePath, isESM);
      if (shortPath === undefined || filePath.length < shortPath.length) {
        shortPath = filePath;
      }

      const dependencies = await getDependencies(
        path.resolve(process.cwd(), filePath)
      );
      for (const [dependency, isESM] of dependencies) {
        if (dependency.startsWith(".") || dependency.startsWith("/")) {
          const nextFilePath = path.resolve(filePath, "..", dependency);
          const nextExt = path.extname(nextFilePath) || impliedExtension;
          fileStack.push([nextFilePath, nextExt, isESM]);
        }
      }
    }
  }
  const absoluteFilePaths = [...explored];

  // Nothing to run
  if (shortPath === undefined) return;
  let commonRootPath = shortPath;

  while (commonRootPath !== "/") {
    commonRootPath = path.join(commonRootPath, "..");

    if (
      absoluteFilePaths.every(([filePath]) => {
        return filePath.startsWith(commonRootPath);
      })
    ) {
      break;
    }
  }

  let outputEntryFilePath;

  const filePaths = absoluteFilePaths.map(([absoluteFilePath, isESM]) => {
    const prevExt = path.extname(absoluteFilePath);
    let relativeFilePath = absoluteFilePath.slice(commonRootPath.length + 1);
    const outputExt = isESM ? ".mjs" : ".cjs";

    if (prevExt === "") {
      relativeFilePath += outputExt;
    } else {
      relativeFilePath = relativeFilePath.slice(0, -prevExt.length) + outputExt;
    }

    if (absoluteFilePath === firstFilePath) {
      outputEntryFilePath = relativeFilePath;
    }

    return [absoluteFilePath, relativeFilePath, isESM];
  });

  const relativePathSet = new Set(
    filePaths.map(([, relativePath]) => {
      return relativePath;
    })
  );

  if (relativePathSet.size < filePaths.length) {
    throw new Error(
      "Cannot import a file at the same path with a different extension"
    );
  }

  await fs.promises.rm(outputDirectory, { recursive: true, force: true });
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    filePaths.map(async ([sourcePath, outputPath, isESM]) => {
      let code;
      if (sourcePath === firstFilePath) {
        code = firstFileParsedString;
      } else {
        code = await sucrase(sourcePath);
      }

      if (code.startsWith("#!")) {
        code = code.slice(code.indexOf("\n") + 1);
      }

      let newFile = await updateImports(code);

      if (isESM && !newFile.includes("createRequire")) {
        newFile =
          "import { createRequire } from 'node:module';\n" +
          "const require = createRequire(import.meta.url);\n" +
          newFile;
      }

      const outputFilePath = path.join(outputDirectory, outputPath);
      await fs.promises.mkdir(path.join(outputFilePath, ".."), {
        recursive: true,
      });
      await fs.promises.writeFile(outputFilePath, newFile);
    })
  );

  return outputEntryFilePath === undefined
    ? undefined
    : path.join(outputDirectory, outputEntryFilePath);
};

const sucrase = async (sourcePath) => {
  return transform(await fs.promises.readFile(sourcePath, "utf8"), {
    transforms: [
      "typescript",
      "jest",
      ...(sourcePath.endsWith(".ts") ? [] : ["jsx"]),
    ],
    jsxPragma: "React.createClass",
    jsxFragmentPragma: "React.Fragment",
    enableLegacyTypeScriptModuleInterop: false,
    enableLegacyBabel5ModuleInterop: false,
    filePath: sourcePath,
    production: false,
    disableESTransforms: true,
  }).code;
};

/**
 * Runs a file, no questions asked (auto-transpiling it and its dependencies as required)
 * @param {string} entryFilePath
 * @param {string[]} args
 * @param {string | undefined} outputDirectory @default path.join(process.cwd(), ".jbuild")
 * @returns {Promise<string | undefined>} outputEntryFilePath
 */
export const run = async (
  entryFilePath,
  args = [],
  outputDirectory = path.join(process.cwd(), ".jrun")
) => {
  const outputEntryFilePath = await build(entryFilePath, outputDirectory);

  if (outputEntryFilePath === undefined) {
    console.error("No entry file to run");
    process.exit(1);
  } else {
    const child = fork(outputEntryFilePath, args, { stdio: "inherit" });
    child.on("exit", async (code) => {
      await fs.promises.rm(outputDirectory, { recursive: true, force: true });
      process.exit(code);
    });
  }
};
