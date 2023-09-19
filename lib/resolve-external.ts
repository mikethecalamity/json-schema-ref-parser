import $Ref from "./ref.js";
import Pointer from "./pointer.js";
import parse from "./parse.js";
import * as url from "./util/url.js";
import { isHandledError } from "./util/errors.js";
import type $Refs from "./refs.js";
import type { Options } from "./options.js";
import type { JSONSchema } from "./types/index.js";
import type $RefParser from "./index.js";

export default resolveExternal;

/**
 * Crawls the JSON schema, finds all external JSON references, and resolves their values.
 * This method does not mutate the JSON schema. The resolved values are added to {@link $RefParser#$refs}.
 *
 * NOTE: We only care about EXTERNAL references here. INTERNAL references are only relevant when dereferencing.
 *
 * @returns
 * The promise resolves once all JSON references in the schema have been resolved,
 * including nested references that are contained in externally-referenced files.
 */
function resolveExternal(parser: $RefParser, options: Options) {
  if (!options.resolve.external) {
    // Nothing to resolve, so exit early
    return Promise.resolve();
  }

  try {
    // console.log('Resolving $ref pointers in %s', parser.$refs._root$Ref.path);
    const promises = crawl(parser.schema, parser.$refs._root$Ref.path + "#", parser.$refs, options);
    return Promise.all(promises);
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * Recursively crawls the given value, and resolves any external JSON references.
 *
 * @param obj - The value to crawl. If it's not an object or array, it will be ignored.
 * @param path - The full path of `obj`, possibly with a JSON Pointer in the hash
 * @param $refs
 * @param options
 * @param external - Whether `obj` was found in an external document.
 * @param seen - Internal.
 *
 * @returns
 * Returns an array of promises. There will be one promise for each JSON reference in `obj`.
 * If `obj` does not contain any JSON references, then the array will be empty.
 * If any of the JSON references point to files that contain additional JSON references,
 * then the corresponding promise will internally reference an array of promises.
 */
function crawl(
  obj: string | Buffer | JSONSchema | undefined | null,
  path: string,
  $refs: $Refs,
  options: Options,
  external: boolean,
  seen?: Set<any>
) {
  seen ||= new Set();
  let promises: any = [];

  if (obj && typeof obj === "object" && !ArrayBuffer.isView(obj) && !seen.has(obj)) {
    seen.add(obj); // Track previously seen objects to avoid infinite recursion
    if ($Ref.isExternal$Ref(obj)) {
      promises.push(resolve$Ref(obj, path, $refs, options));
    } else {
      if (external && $Ref.is$Ref(obj)) {
        /* Correct the reference in the external document so we can resolve it */
        const withoutHash = url.stripHash(path);
        obj.$ref = withoutHash + obj.$ref;
      }

      for (const key of Object.keys(obj)) {
        const keyPath = Pointer.join(path, key);
        const value = obj[key] as string | JSONSchema | Buffer | undefined;

        promises = promises.concat(crawl(value, keyPath, $refs, options, external, seen));
      }
    }
  }

  return promises;
}

/**
 * Resolves the given JSON Reference, and then crawls the resulting value.
 *
 * @param $ref - The JSON Reference to resolve
 * @param path - The full path of `$ref`, possibly with a JSON Pointer in the hash
 * @param $refs
 * @param options
 *
 * @returns
 * The promise resolves once all JSON references in the object have been resolved,
 * including nested references that are contained in externally-referenced files.
 */
async function resolve$Ref($ref: JSONSchema, path: string, $refs: $Refs, options: Options) {
  // console.log('Resolving $ref pointer "%s" at %s', $ref.$ref, path);

  const resolvedPath = url.resolve(path, $ref.$ref);
  const withoutHash = url.stripHash(resolvedPath);

  /** 
     Correct the $ref to use a path relative to the root, so that $Refs._resolve can resolve it,
     otherwise transitive relative external references will be incorrect if the second external
     relative ref doesn't work relative to the root document.
   */
  $ref.$ref = url.relative($refs._root$Ref.path, resolvedPath);

  // Do we already have this $ref?
  $ref = $refs._$refs[withoutHash];
  if ($ref) {
    // We've already parsed this $ref, so use the existing value
    return Promise.resolve($ref.value);
  }

  // Parse the $referenced file/url
  try {
    const result = await parse(resolvedPath, $refs, options);

    // Crawl the parsed value
    // console.log('Resolving $ref pointers in %s', withoutHash);
    const promises = crawl(result, withoutHash + "#", $refs, options, true);

    return Promise.all(promises);
  } catch (err) {
    if (!options?.continueOnError || !isHandledError(err)) {
      throw err;
    }

    if ($refs._$refs[withoutHash]) {
      err.source = decodeURI(url.stripHash(path));
      err.path = url.safePointerToPath(url.getHash(path));
    }

    return [];
  }
}
