import { describe, it, expect } from "vitest";
import { parseDynamodbUri, DYNAMO_ENDPOINT_REJECTED, DYNAMO_REGION_REJECTED } from "../dynamodb";

const withEndpoint = (ep: string, region = "us-west-1") =>
  `dynamodb://AKIAX:secret@${region}?endpoint=${encodeURIComponent(ep)}`;

describe("DynamoDB endpoint must be the DynamoDB host for the connection's region (SSRF)", () => {
  it.each([
    "http://169.254.169.254",
    "http://localhost:8000",
    "https://evil.com",
    "https://1.2.3.4",
    "https://dynamodb.us-west-1.amazonaws.com.evil.com",
    "http://dynamodb.us-west-1.amazonaws.com",
    "https://user:pw@dynamodb.us-west-1.amazonaws.com",
    "https://dynamodb.us-west-1.amazonaws.com:8443",
    "https://dynamodb.us-west-1.amazonaws.com/proxy",
    "https://dynamodb.us-west-1.amazonaws.com/?x=1",
    "https://dynamodb.us-west-1.amazonaws.com/#f",
    "https://abc.execute-api.us-west-1.amazonaws.com",
    "https://x.s3-website-us-west-1.amazonaws.com",
    "https://dynamodb.us-east-1.amazonaws.com",
    "https://[::1]",
    "https://2130706433",
    "not a url",
  ])("rejects endpoint %s", (ep) => {
    expect(() => parseDynamodbUri(withEndpoint(ep))).toThrow(DYNAMO_ENDPOINT_REJECTED);
  });

  it.each(["evil.com", "us-west-1.evil", "169.254.169.254", "localhost"])("rejects region %s", (region) => {
    expect(() => parseDynamodbUri(`dynamodb://AKIAX:secret@${region}`)).toThrow(DYNAMO_REGION_REJECTED);
  });

  it.each(["us-west-1", "us-gov-west-1", "cn-north-1", "eu-central-2"])("accepts region %s", (region) => {
    expect(parseDynamodbUri(`dynamodb://AKIAX:secret@${region}`).region).toBe(region);
  });

  it("accepts no endpoint", () => {
    expect(parseDynamodbUri("dynamodb://AKIAX:secret@us-west-1").endpoint).toBeUndefined();
  });

  it.each([
    ["https://dynamodb.us-west-1.amazonaws.com", "us-west-1"],
    ["https://dynamodb.us-west-1.amazonaws.com/", "us-west-1"],
    ["https://dynamodb-fips.us-gov-west-1.amazonaws.com", "us-gov-west-1"],
    ["https://dynamodb.cn-north-1.amazonaws.com.cn", "cn-north-1"],
    ["https://vpce-0abc123-xyz.dynamodb.us-west-1.vpce.amazonaws.com", "us-west-1"],
  ])("accepts %s in %s", (ep, region) => {
    expect(parseDynamodbUri(withEndpoint(ep, region)).endpoint).toBe(ep.replace(/\/$/, ""));
  });
});
