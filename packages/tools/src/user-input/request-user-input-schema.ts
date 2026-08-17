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
          description: { type: "string", minLength: 1, maxLength: 1000 },
          type: { enum: ["single", "multiple", "text"] },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1, maxLength: 64 },
                label: { type: "string", minLength: 1, maxLength: 200 },
                description: { type: "string", minLength: 1, maxLength: 500 },
              },
              required: ["id", "label"],
            },
          },
          placeholder: { type: "string", minLength: 1, maxLength: 500 },
          required: { type: "boolean" },
          allowOther: { type: "boolean" },
        },
        required: ["id", "question", "type"],
      },
    },
  },
  required: ["questions"],
} as const;
