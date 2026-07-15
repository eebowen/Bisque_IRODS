const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BisqueApiError,
  BisqueClient,
  escapeXml,
  extractUploadedResourceUris,
  normalizeIrodsPath,
} = require("../src/bisque-client");

test("escapes XML values used in registration and dataset documents", () => {
  assert.equal(escapeXml('A&B <set> "one"'), "A&amp;B &lt;set&gt; &quot;one&quot;");
});

test("validates iRODS paths before sending them to BisQue", () => {
  assert.equal(
    normalizeIrodsPath("/ucsb/home/bowen68/test/image.jpg"),
    "/ucsb/home/bowen68/test/image.jpg",
  );
  assert.throws(
    () => normalizeIrodsPath("/ucsb/home/bowen68/../admin/image.jpg"),
    (error) => error instanceof BisqueApiError && error.code === "INVALID_IRODS_PATH",
  );
});

test("extracts image and non-image resources, adding member values on request", () => {
  const xml = `
    <resource type="uploaded">
      <image uri="/data_service/00-image-one" />
      <file uri="/data_service/00-file-one" />
      <dataset>
        <value type="object">https://bisque2.ece.ucsb.edu/data_service/00-image-two</value>
      </dataset>
    </resource>`;
  assert.deepEqual(extractUploadedResourceUris(xml, "https://bisque2.ece.ucsb.edu"), [
    "https://bisque2.ece.ucsb.edu/data_service/00-image-one",
    "https://bisque2.ece.ucsb.edu/data_service/00-file-one",
  ]);
  assert.deepEqual(
    extractUploadedResourceUris(xml, "https://bisque2.ece.ucsb.edu", { includeMemberValues: true }),
    [
      "https://bisque2.ece.ucsb.edu/data_service/00-image-one",
      "https://bisque2.ece.ucsb.edu/data_service/00-file-one",
      "https://bisque2.ece.ucsb.edu/data_service/00-image-two",
    ],
  );
});

test("registers uploaded paths and creates one named BisQue dataset", async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/import/insert_inplace")) {
      return {
        status: 200,
        headers: {},
        body: '<resource type="uploaded"><image uri="/data_service/00-image" /></resource>',
      };
    }
    if (url.includes("/data_service/dataset?name=")) {
      return { status: 200, headers: {}, body: "<resource />" };
    }
    if (url.endsWith("/data_service/dataset")) {
      return {
        status: 201,
        headers: {},
        body: '<dataset name="A &amp; B" uri="/data_service/00-dataset" />',
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  const result = await client.createDatasetFromIrodsPaths({
    datasetName: "A & B",
    irodsPaths: ["/ucsb/home/bowen68/test/image.jpg"],
  });

  assert.equal(result.datasetUri, "https://bisque2.ece.ucsb.edu/data_service/00-dataset");
  assert.deepEqual(result.resourceUris, ["https://bisque2.ece.ucsb.edu/data_service/00-image"]);
  assert.equal(result.appendedToExisting, false);
  assert.equal(requests.length, 3);

  const registrationForm = new URLSearchParams(requests[0].options.body);
  assert.match(
    registrationForm.get("irods_resource"),
    /value="irods:\/\/brain\.ece\.ucsb\.edu\/ucsb\/home\/bowen68\/test\/image\.jpg"/,
  );
  assert.match(requests[0].options.headers.Authorization, /^Basic /);
  assert.equal(requests[0].options.body.includes("secret"), false);
  assert.match(requests[1].url, /\/data_service\/dataset\?name=A%20%26%20B$/);
  assert.equal(
    requests[2].options.body,
    '<dataset name="A &amp; B"><value type="object">https://bisque2.ece.ucsb.edu/data_service/00-image</value></dataset>',
  );
});

test("expands a BisQue dataset returned while registering a multi-image file", async () => {
  const request = async (url) => {
    if (url.endsWith("/import/insert_inplace")) {
      return {
        status: 200,
        headers: {},
        body: '<resource type="uploaded"><dataset uri="/data_service/00-imported-set" /></resource>',
      };
    }
    if (url.includes("/data_service/00-imported-set?view=deep")) {
      return {
        status: 200,
        headers: {},
        body:
          '<dataset><value type="object">/data_service/00-a</value>' +
          '<value type="object">/data_service/00-b</value></dataset>',
      };
    }
    if (url.includes("/data_service/dataset?name=")) {
      return { status: 200, headers: {}, body: "<resource />" };
    }
    if (url.endsWith("/data_service/dataset")) {
      return { status: 201, headers: {}, body: '<dataset uri="/data_service/00-final" />' };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  const result = await client.createDatasetFromIrodsPaths({
    datasetName: "Series",
    irodsPaths: ["/ucsb/home/bowen68/test/series.zip"],
  });

  assert.deepEqual(result.resourceUris, [
    "https://bisque2.ece.ucsb.edu/data_service/00-a",
    "https://bisque2.ece.ucsb.edu/data_service/00-b",
  ]);
});

test("adds non-image files such as PDFs to the dataset", async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/import/insert_inplace")) {
      return {
        status: 200,
        headers: {},
        body: '<resource type="uploaded"><file uri="/data_service/00-file" /></resource>',
      };
    }
    if (url.includes("/data_service/dataset?name=")) {
      return { status: 200, headers: {}, body: "<resource />" };
    }
    if (url.endsWith("/data_service/dataset")) {
      return { status: 201, headers: {}, body: '<dataset uri="/data_service/00-docs" />' };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  const result = await client.createDatasetFromIrodsPaths({
    datasetName: "Documents",
    irodsPaths: ["/ucsb/home/bowen68/test/wan2.1.pdf"],
  });

  assert.deepEqual(result.resourceUris, ["https://bisque2.ece.ucsb.edu/data_service/00-file"]);
  assert.deepEqual(result.skipped, []);
  const datasetRequest = requests.find((entry) => entry.url.endsWith("/data_service/dataset"));
  assert.match(
    datasetRequest.options.body,
    /<value type="object">https:\/\/bisque2\.ece\.ucsb\.edu\/data_service\/00-file<\/value>/,
  );
});

test("adds new files to an existing BisQue dataset with the same name", async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/import/insert_inplace")) {
      return {
        status: 200,
        headers: {},
        body: '<resource type="uploaded"><image uri="/data_service/00-new" /></resource>',
      };
    }
    if (url.includes("/data_service/dataset?name=")) {
      return {
        status: 200,
        headers: {},
        body: '<resource><dataset name="July scans" uri="/data_service/00-existing" /></resource>',
      };
    }
    if (url.includes("/data_service/00-existing?view=full")) {
      return {
        status: 200,
        headers: {},
        body:
          '<dataset name="July scans" uri="/data_service/00-existing">' +
          '<tag name="note" value="keep me" />' +
          '<value index="0" type="object">https://bisque2.ece.ucsb.edu/data_service/00-old</value>' +
          "</dataset>",
      };
    }
    if (url.endsWith("/data_service/00-existing")) {
      return { status: 200, headers: {}, body: '<dataset uri="/data_service/00-existing" />' };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  const result = await client.createDatasetFromIrodsPaths({
    datasetName: "July scans",
    irodsPaths: ["/ucsb/home/bowen68/test/new.jpg"],
  });

  assert.equal(result.datasetUri, "https://bisque2.ece.ucsb.edu/data_service/00-existing");
  assert.equal(result.appendedToExisting, true);
  assert.equal(result.addedCount, 1);
  assert.equal(result.memberCount, 2);

  const update = requests.find((entry) => entry.options.method === "PUT");
  assert.ok(update, "expected a PUT update of the existing dataset");
  assert.equal(update.url, "https://bisque2.ece.ucsb.edu/data_service/00-existing");
  assert.match(update.options.body, /00-old/);
  assert.match(update.options.body, /keep me/);
  assert.match(
    update.options.body,
    /<value type="object">https:\/\/bisque2\.ece\.ucsb\.edu\/data_service\/00-new<\/value><\/dataset>/,
  );
  const creations = requests.filter(
    (entry) => entry.url.endsWith("/data_service/dataset") && entry.options.method === "POST",
  );
  assert.equal(creations.length, 0, "must not create a duplicate dataset");
});

test("does not duplicate members that are already in the dataset", async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/import/insert_inplace")) {
      return {
        status: 200,
        headers: {},
        body: '<resource type="uploaded"><image uri="/data_service/00-old" /></resource>',
      };
    }
    if (url.includes("/data_service/dataset?name=")) {
      return {
        status: 200,
        headers: {},
        body: '<resource><dataset name="July scans" uri="/data_service/00-existing" /></resource>',
      };
    }
    if (url.includes("/data_service/00-existing?view=full")) {
      return {
        status: 200,
        headers: {},
        body:
          '<dataset name="July scans" uri="/data_service/00-existing">' +
          '<value index="0" type="object">https://bisque2.ece.ucsb.edu/data_service/00-old</value>' +
          "</dataset>",
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  const result = await client.createDatasetFromIrodsPaths({
    datasetName: "July scans",
    irodsPaths: ["/ucsb/home/bowen68/test/old.jpg"],
  });

  assert.equal(result.appendedToExisting, true);
  assert.equal(result.addedCount, 0);
  assert.equal(result.memberCount, 1);
  assert.ok(
    requests.every((entry) => entry.options.method !== "PUT"),
    "must not rewrite the dataset when nothing new was added",
  );
});

test("does not create an empty dataset when BisQue returns no resources", async () => {
  const request = async () => ({
    status: 200,
    headers: {},
    body: '<resource type="uploaded" />',
  });
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  await assert.rejects(
    client.createDatasetFromIrodsPaths({
      datasetName: "Nothing registered",
      irodsPaths: ["/ucsb/home/bowen68/test/notes.txt"],
    }),
    (error) => error instanceof BisqueApiError && error.code === "NO_BISQUE_RESOURCES",
  );
});

test("falls back to a direct BisQue upload when in-place registration fails", async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/import/insert_inplace")) {
      return {
        status: 200,
        headers: {},
        body: '<resource type="uploaded"><tag name="error" value="Error ingesting file"/></resource>',
      };
    }
    if (url.endsWith("/import/transfer")) {
      return {
        status: 200,
        headers: {},
        body: '<resource type="uploaded"><image uri="/data_service/00-direct" /></resource>',
      };
    }
    if (url.includes("/data_service/dataset?name=")) {
      return { status: 200, headers: {}, body: "<resource />" };
    }
    if (url.endsWith("/data_service/dataset")) {
      return { status: 201, headers: {}, body: '<dataset uri="/data_service/00-set" />' };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  const result = await client.createDatasetFromIrodsPaths({
    datasetName: "Fallback",
    files: [{ irodsPath: "/ucsb/home/bowen68/test/image.jpg", localPath: __filename }],
  });

  assert.deepEqual(result.resourceUris, ["https://bisque2.ece.ucsb.edu/data_service/00-direct"]);
  assert.deepEqual(result.failed, []);

  const transfer = requests.find((entry) => entry.url.endsWith("/import/transfer"));
  assert.ok(transfer, "expected a direct transfer request");
  assert.match(transfer.options.headers["Content-Type"], /^multipart\/form-data; boundary=/);
  assert.equal(transfer.options.bodyParts[1].filePath, __filename);
  assert.match(transfer.options.bodyParts[0].toString("utf8"), /filename="image\.jpg"/);
});

test("reports files that fail registration and still creates the dataset", async () => {
  const request = async (url, options) => {
    if (url.endsWith("/import/insert_inplace")) {
      const failing = String(options.body).includes("broken");
      return {
        status: 200,
        headers: {},
        body: failing
          ? '<resource type="uploaded"><tag name="error" value="Error ingesting file"/></resource>'
          : '<resource type="uploaded"><image uri="/data_service/00-good" /></resource>',
      };
    }
    if (url.includes("/data_service/dataset?name=")) {
      return { status: 200, headers: {}, body: "<resource />" };
    }
    if (url.endsWith("/data_service/dataset")) {
      return { status: 201, headers: {}, body: '<dataset uri="/data_service/00-set" />' };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  const result = await client.createDatasetFromIrodsPaths({
    datasetName: "Partial",
    files: [
      { irodsPath: "/ucsb/home/bowen68/test/broken.jpg" },
      { irodsPath: "/ucsb/home/bowen68/test/good.jpg" },
    ],
  });

  assert.deepEqual(result.resourceUris, ["https://bisque2.ece.ucsb.edu/data_service/00-good"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].irodsPath, "/ucsb/home/bowen68/test/broken.jpg");
  assert.match(result.failed[0].reason, /Error ingesting file/);
});

test("creates a dataset from local files without touching iRODS", async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/import/transfer")) {
      return {
        status: 200,
        headers: {},
        body: `<resource type="uploaded"><image uri="/data_service/00-local-${requests.length}" /></resource>`,
      };
    }
    if (url.includes("/data_service/dataset?name=")) {
      return { status: 200, headers: {}, body: "<resource />" };
    }
    if (url.endsWith("/data_service/dataset")) {
      return { status: 201, headers: {}, body: '<dataset uri="/data_service/00-local-set" />' };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  const result = await client.createDatasetFromLocalFiles({
    datasetName: "Local only",
    files: [
      { localPath: __filename, name: "folder/one.jpg" },
      { localPath: require.resolve("../src/bisque-client.js"), name: "folder/two.jpg" },
    ],
  });

  assert.equal(result.datasetUri, "https://bisque2.ece.ucsb.edu/data_service/00-local-set");
  assert.equal(result.resourceUris.length, 2);
  assert.deepEqual(result.failed, []);
  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/import/insert_inplace")).length,
    0,
  );
  assert.equal(requests.filter((entry) => entry.url.endsWith("/import/transfer")).length, 2);
});

test("keeps going when one local file fails to upload", async () => {
  let transfers = 0;
  const request = async (url) => {
    if (url.endsWith("/import/transfer")) {
      transfers += 1;
      if (transfers === 1) return { status: 500, headers: {}, body: "" };
      return {
        status: 200,
        headers: {},
        body: '<resource type="uploaded"><image uri="/data_service/00-ok" /></resource>',
      };
    }
    if (url.includes("/data_service/dataset?name=")) {
      return { status: 200, headers: {}, body: "<resource />" };
    }
    if (url.endsWith("/data_service/dataset")) {
      return { status: 201, headers: {}, body: '<dataset uri="/data_service/00-set" />' };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new BisqueClient({
    username: "bowen68",
    password: "secret",
    request,
    retryDelays: [],
  });

  const result = await client.createDatasetFromLocalFiles({
    datasetName: "Partial local",
    files: [
      { localPath: __filename, name: "bad.jpg" },
      { localPath: require.resolve("../src/bisque-client.js"), name: "good.jpg" },
    ],
  });

  assert.deepEqual(result.resourceUris, ["https://bisque2.ece.ucsb.edu/data_service/00-ok"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, "bad.jpg");
});

test("fails with a summary when no file can be registered at all", async () => {
  const request = async () => ({
    status: 200,
    headers: {},
    body: '<resource type="uploaded"><tag name="error" value="Error ingesting file"/></resource>',
  });
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  await assert.rejects(
    client.createDatasetFromIrodsPaths({
      datasetName: "Nothing",
      irodsPaths: ["/ucsb/home/bowen68/test/image.jpg"],
    }),
    (error) => error instanceof BisqueApiError && error.code === "BISQUE_REGISTRATION_FAILED",
  );
});

test("retries transient network and server errors before succeeding", async () => {
  let transfers = 0;
  const request = async (url) => {
    if (url.endsWith("/import/transfer")) {
      transfers += 1;
      if (transfers === 1) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      if (transfers === 2) return { status: 503, headers: {}, body: "" };
      return {
        status: 200,
        headers: {},
        body: '<resource type="uploaded"><image uri="/data_service/00-retried" /></resource>',
      };
    }
    if (url.includes("/data_service/dataset?name=")) {
      return { status: 200, headers: {}, body: "<resource />" };
    }
    if (url.endsWith("/data_service/dataset")) {
      return { status: 201, headers: {}, body: '<dataset uri="/data_service/00-set" />' };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new BisqueClient({
    username: "bowen68",
    password: "secret",
    request,
    retryDelays: [0, 0],
  });

  const retryEvents = [];
  const result = await client.createDatasetFromLocalFiles({
    datasetName: "Flaky network",
    files: [{ localPath: __filename, name: "image.jpg" }],
    onProgress: (event) => {
      if (event.stage === "retry") retryEvents.push(event);
    },
  });

  assert.deepEqual(result.resourceUris, ["https://bisque2.ece.ucsb.edu/data_service/00-retried"]);
  assert.deepEqual(result.failed, []);
  assert.equal(transfers, 3);
  assert.equal(retryEvents.length, 2);
  assert.equal(retryEvents[0].attempt, 1);
  assert.equal(retryEvents[0].maxAttempts, 3);
});

test("does not retry when BisQue rejects the file itself", async () => {
  let transfers = 0;
  const request = async (url) => {
    if (url.endsWith("/import/transfer")) {
      transfers += 1;
      return {
        status: 200,
        headers: {},
        body: '<resource type="uploaded"><tag name="error" value="unsupported format"/></resource>',
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  await assert.rejects(
    client.createDatasetFromLocalFiles({
      datasetName: "Rejected",
      files: [{ localPath: __filename, name: "image.jpg" }],
    }),
    (error) => error instanceof BisqueApiError && error.code === "BISQUE_REGISTRATION_FAILED",
  );
  assert.equal(transfers, 1);
});

test("stops immediately when BisQue rejects the credentials", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    return { status: 401, headers: {}, body: "" };
  };
  const client = new BisqueClient({ username: "bowen68", password: "wrong", request });

  await assert.rejects(
    client.createDatasetFromIrodsPaths({
      datasetName: "Auth",
      irodsPaths: ["/ucsb/home/bowen68/a.jpg", "/ucsb/home/bowen68/b.jpg"],
    }),
    (error) => error instanceof BisqueApiError && error.code === "BISQUE_AUTH_FAILED",
  );
  assert.equal(calls, 1);
});

test("surfaces an unsupported iRODS registration error", async () => {
  const request = async () => ({
    status: 200,
    headers: {},
    body: '<resource><tag name="error" value="unsupported irods URL scheme" /></resource>',
  });
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  await assert.rejects(
    client.registerIrodsPath("/ucsb/home/bowen68/test/image.jpg"),
    (error) => error instanceof BisqueApiError && error.code === "IRODS_REGISTRATION_UNAVAILABLE",
  );
});
