import type {
    ModelProvider,
    ModelRequest,
    ModelResponse,
} from "../../src/model.ts";

export class FakeModelProvider implements ModelProvider {
    readonly requests: ModelRequest[] = [];
    readonly #responses: ModelResponse[];

    constructor(responses: readonly ModelResponse[]) {
        this.#responses = [...responses];
    }

    async generate(request: ModelRequest): Promise<ModelResponse> {
        this.requests.push(request);

        const response = this.#responses.shift();
        if (response === undefined) {
            throw new Error("FakeModelProvider has no response left");
        }

        return response;
    }

    get remainingResponses(): number {
        return this.#responses.length;
    }
}
