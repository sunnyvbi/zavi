
import { ExpectedToolError } from "@/services/tools/types";

const FATAL_MONGO_CODES = new Set([
  13,
  18,
  50,
  11600,
  11601,
  11602,
]);

const FATAL_MONGO_CLASSES = new Set([
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoTopologyClosedError",
]);

const AUTH_SENTENCE =
  /(not authorized\b|authentication failed|requires authentication|user .{0,40}not allowed|no permission to (?:execute|run|read|find|aggregate))/i;

const BARE_AUTH_MESSAGE = /^\(?(?:atlaserror|mongoerror)?\)?\s*(unauthorized|forbidden)\.?$/i;

function withoutQuotedValues(message: string): string {
  return (
    message
      .replace(
        /\b(failed to parse|failed to convert|could not convert|unsupported conversion)\b[\s\S]*\bin \$\w+(?=\s*$|\s+with\b|\s*[,;)\]}])/gi,
        " ",
      )
      .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, " ")
  );
}

function saysAuth(e: unknown): boolean {
  const codeName = (e as { codeName?: unknown }).codeName;
  if (typeof codeName === "string" && /^(unauthorized|authenticationfailed|forbidden)$/i.test(codeName)) {
    return true;
  }
  const message = (e as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  const unquoted = withoutQuotedValues(message);
  return AUTH_SENTENCE.test(unquoted) || BARE_AUTH_MESSAGE.test(unquoted.trim());
}

export function isAgentFixableMongoError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const name = (e as { name?: unknown }).name;
  if (typeof name === "string" && FATAL_MONGO_CLASSES.has(name)) return false;
  if (typeof name !== "string" || name !== "MongoServerError") return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "number" && FATAL_MONGO_CODES.has(code)) return false;
  if (saysAuth(e)) return false;
  return true;
}

const OPERATOR_TOKEN = /\$[a-zA-Z][a-zA-Z0-9]*/g;

const KNOWN_OPERATORS = new Set<string>([
  "$match", "$project", "$group", "$sort", "$limit", "$skip", "$count",
  "$unwind", "$lookup", "$facet", "$addFields", "$set", "$replaceRoot",
  "$replaceWith", "$sortByCount", "$bucket", "$bucketAuto", "$sample",
  "$sum", "$avg", "$min", "$max", "$first", "$last", "$push", "$addToSet",
  "$size", "$type", "$cond", "$ifNull", "$switch", "$literal", "$toString",
  "$toInt", "$toLong", "$toDouble", "$toDecimal", "$toDate", "$toObjectId",
  "$convert", "$dateTrunc", "$dateToString", "$dateFromString", "$dateDiff",
  "$dateAdd", "$dateSubtract", "$year", "$month", "$dayOfMonth", "$week",
  "$hour", "$minute", "$divide", "$multiply", "$add", "$subtract", "$mod",
  "$abs", "$ceil", "$floor", "$round", "$trunc", "$concat", "$substr",
  "$substrBytes", "$substrCP", "$toUpper", "$toLower", "$trim", "$split",
  "$strLenCP", "$regexMatch", "$regexFind", "$in", "$nin", "$eq", "$ne",
  "$gt", "$gte", "$lt", "$lte", "$and", "$or", "$not", "$exists", "$regex",
  "$elemMatch", "$all", "$slice", "$range", "$reduce", "$map", "$filter",
  "$arrayElemAt", "$concatArrays", "$isArray", "$objectToArray",
  "$arrayToObject", "$mergeObjects", "$let", "$zip", "$reverseArray",
  "$dateFromParts", "$dateToParts", "$dayOfWeek", "$dayOfYear", "$isoWeek",
  "$isoWeekYear", "$isoDayOfWeek", "$second", "$millisecond", "$indexOfCP",
  "$indexOfBytes", "$indexOfArray", "$strcasecmp", "$replaceOne", "$replaceAll",
  "$ltrim", "$rtrim", "$sqrt", "$pow", "$exp", "$ln", "$log", "$log10",
  "$stdDevPop", "$stdDevSamp", "$covariancePop", "$percentile", "$median",
  "$setUnion", "$setIntersection", "$setDifference", "$setEquals", "$anyElementTrue",
  "$allElementsTrue", "$firstN", "$lastN", "$maxN", "$minN", "$sortArray",
  "$toBool", "$binarySize", "$bsonSize", "$getField", "$setField", "$unsetField",
  "$nor",
]);

const KNOWN_REASONS: { probe: RegExp; say: string }[] = [
  { probe: /must be an array/i, say: "the argument must be an array" },
  { probe: /must be a (string|number|date|document|object)/i, say: "the argument is the wrong type" },
  { probe: /unknown (top level )?operator|unrecognized (expression|pipeline stage)/i, say: "that operator does not exist" },
  { probe: /is not allowed|not permitted/i, say: "that operator is not allowed here" },
  { probe: /can't convert|cannot convert|failed to convert/i, say: "a value could not be converted to the type the operator wanted" },
  { probe: /field path|FieldPath|dotted field/i, say: "a field path is malformed" },
  { probe: /takes exactly \d+ argument|requires \d+ argument|wrong number of arguments/i, say: "that operator was given the wrong number of arguments" },
  { probe: /division by zero|can't \$divide|cannot \$divide/i, say: "a division had a zero or non-numeric divisor" },
  { probe: /exceeded memory limit|sort exceeded/i, say: "the stage ran out of memory — aggregate earlier in the pipeline" },
  { probe: /duplicate field|conflict/i, say: "two stages set the same field" },
  { probe: /must be a positive|out of range|invalid range/i, say: "a numeric argument is out of range" },
];

export function describeMongoError(e: unknown): string {
  const raw = (e as { message?: unknown }).message;
  const text = typeof raw === "string" ? raw : "";
  const codeName = (e as { codeName?: unknown }).codeName;
  const code = (e as { code?: unknown }).code;

  const operators = [...new Set(text.match(OPERATOR_TOKEN) ?? [])]
    .filter((t) => KNOWN_OPERATORS.has(t))
    .slice(0, 5);
  const reason = KNOWN_REASONS.find((r) => r.probe.test(text))?.say;

  const parts: string[] = ["the database rejected the read"];
  if (operators.length > 0) parts.push(`at ${operators.join(", ")}`);
  if (reason) parts.push(`— ${reason}`);
  const label =
    typeof codeName === "string" && codeName.length > 0
      ? codeName
      : typeof code === "number"
        ? `code ${code}`
        : "MongoServerError";
  parts.push(`(${label})`);
  if (!reason) {
    parts.push(
      "— the engine's wording is withheld because a Mongo error quotes the pipeline back, and the pipeline can carry customer data",
    );
  }
  return parts.join(" ");
}

export function rethrowMongoAsRecoverable(e: unknown, collection: string): never {
  if (isAgentFixableMongoError(e)) {
    throw new ExpectedToolError(
      "operator_db_read_failed",
      `The read against "${collection}" was rejected by the database. Check the field names and operator ` +
        `types against operator_db__catalog and call the tool again with a corrected pipeline; see meta.db_message.`,
      { collection, db_message: describeMongoError(e) },
    );
  }
  throw e;
}

