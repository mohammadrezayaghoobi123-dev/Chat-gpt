export default {
  async fetch() {
    return Response.json(
      { error: { code: "NOT_IMPLEMENTED", message: "Admission signer is not configured." } },
      { status: 501 },
    );
  },
};
