const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BisqueApiError,
  BisqueClient,
  escapeXml,
  extractImageUris,
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

test("extracts direct images and object members from BisQue XML", () => {
  const xml = `
    <resource type="uploaded">
      <image uri="/data_service/00-image-one" />
      <dataset>
        <value type="object">https://bisque2.ece.ucsb.edu/data_service/00-image-two</value>
      </dataset>
    </resource>`;
  assert.deepEqual(extractImageUris(xml, "https://bisque2.ece.ucsb.edu"), [
    "https://bisque2.ece.ucsb.edu/data_service/00-image-one",
    "https://bisque2.ece.ucsb.edu/data_service/00-image-two",
  ]);
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
  assert.deepEqual(result.imageUris, ["https://bisque2.ece.ucsb.edu/data_service/00-image"]);
  assert.equal(requests.length, 2);

  const registrationForm = new URLSearchParams(requests[0].options.body);
  assert.match(
    registrationForm.get("irods_resource"),
    /value="irods:\/\/brain\.ece\.ucsb\.edu\/ucsb\/home\/bowen68\/test\/image\.jpg"/,
  );
  assert.match(requests[0].options.headers.Authorization, /^Basic /);
  assert.equal(requests[0].options.body.includes("secret"), false);
  assert.equal(
    requests[1].options.body,
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

  assert.deepEqual(result.imageUris, [
    "https://bisque2.ece.ucsb.edu/data_service/00-a",
    "https://bisque2.ece.ucsb.edu/data_service/00-b",
  ]);
});

test("does not create an empty dataset when BisQue returns no images", async () => {
  const request = async () => ({
    status: 200,
    headers: {},
    body: '<resource type="uploaded"><file uri="/data_service/00-file" /></resource>',
  });
  const client = new BisqueClient({ username: "bowen68", password: "secret", request });

  await assert.rejects(
    client.createDatasetFromIrodsPaths({
      datasetName: "Not images",
      irodsPaths: ["/ucsb/home/bowen68/test/notes.txt"],
    }),
    (error) => error instanceof BisqueApiError && error.code === "NO_BISQUE_IMAGES",
  );
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
