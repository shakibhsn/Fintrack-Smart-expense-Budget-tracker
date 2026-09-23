// Generic Zod-based request body validator.
// Usage: router.post('/register', validate(registerSchema), registerUser)
const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    res.status(400);
    return next(new Error(message));
  }
  req.body = result.data;
  next();
};

module.exports = validate;
