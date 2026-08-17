export const requestUserInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    context: { type: "string", minLength: 1, maxLength: 2000 },
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          question: { type: "string", minLength: 1, maxLength: 500 },
          description: {
            type: "string",
            minLength: 1,
            maxLength: 1000,
            description: "Why this decision matters or what tradeoff the user is choosing.",
          },
          type: {
            enum: ["single", "multiple", "text"],
            description:
              "Prefer single for mutually exclusive choices, multiple only when choices genuinely combine, and text only when predefined choices cannot represent the answer.",
          },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 64,
                  description: "A stable machine-readable identifier for this option.",
                },
                label: {
                  type: "string",
                  minLength: 1,
                  maxLength: 200,
                  description: "Required user-visible text for this option.",
                },
                description: {
                  type: "string",
                  minLength: 1,
                  maxLength: 500,
                  description: "A concise impact or tradeoff for this option.",
                },
              },
              required: ["id", "label"],
            },
          },
          placeholder: { type: "string", minLength: 1, maxLength: 500 },
          required: { type: "boolean" },
          allowOther: {
            type: "boolean",
            description:
              "Allow a typed answer outside the predefined options. Use this instead of adding a generic Custom or Other option.",
          },
        },
        required: ["id", "question", "type"],
      },
    },
  },
  required: ["questions"],
} as const;
