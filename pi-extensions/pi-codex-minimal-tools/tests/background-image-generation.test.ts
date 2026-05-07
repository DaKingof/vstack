import assert from "node:assert/strict";
import test from "node:test";
import { buildBackgroundImageRequest, parseImageGenCommandArgs } from "../src/background-image-generation.js";

test("parseImageGenCommandArgs separates @reference images from prompt", () => {
	assert.deepEqual(parseImageGenCommandArgs("make it green @icon.png 'with soft shadows' @refs/logo.webp"), {
		prompt: "make it green with soft shadows",
		imagePaths: ["icon.png", "refs/logo.webp"],
	});
});

test("buildBackgroundImageRequest requests generate without reference images", () => {
	const body = buildBackgroundImageRequest({ prompt: "draw a red apple", referenceImages: [], responsesModel: "gpt-5.5", imageModel: "gpt-image-2" });
	assert.equal(body.model, "gpt-5.5");
	assert.deepEqual(body.tools, [{ type: "image_generation", model: "gpt-image-2", output_format: "png", action: "generate" }]);
	assert.deepEqual(body.tool_choice, { type: "image_generation" });
});

test("buildBackgroundImageRequest requests edit with reference images", () => {
	const body = buildBackgroundImageRequest({
		prompt: "change icon to green",
		referenceImages: [{ path: "/tmp/icon.png", mimeType: "image/png", base64: "abc" }],
		responsesModel: "gpt-5.5",
		imageModel: "gpt-image-2",
	});
	assert.deepEqual(body.tools, [{ type: "image_generation", model: "gpt-image-2", output_format: "png", action: "edit" }]);
	const input = body.input as Array<{ content: Array<{ type: string; text?: string; image_url?: string }> }>;
	assert.equal(input[0].content[0].text, "Edit the provided image(s): change icon to green");
	assert.equal(input[0].content[1].type, "input_image");
	assert.equal(input[0].content[1].image_url, "data:image/png;base64,abc");
});
