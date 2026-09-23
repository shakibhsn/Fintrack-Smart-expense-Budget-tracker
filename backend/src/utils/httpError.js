// Small helper so controllers can do: throw httpError(404, 'Transaction not found')
const httpError = (status, message) => {
  const err = new Error(message);
  err.statusCode = status;
  return err;
};

module.exports = httpError;
