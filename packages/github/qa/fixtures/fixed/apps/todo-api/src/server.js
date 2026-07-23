import express from "express";

const app = express();
app.use(express.json());

const todos = [];
let nextId = 1;

// Search todos by title
function findTodosByTitle(title) {
  // Escape special regex characters from user input
  const pattern = new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return todos.filter((t) => pattern.test(t.title));
}

app.delete("/api/todos/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const index = todos.findIndex((t) => t.id === id);
  if (index === -1) {
    return res.status(404).json({ error: "Not found" });
  }
  todos.splice(index, 1);
  res.json({ deleted: true });
});

app.get("/api/stats", (req, res) => {
  const completed = todos.filter((t) => t.done).length;
  const total = todos.length;
  res.json({
    total,
    completed,
    completionRate: total > 0 ? completed / total : 0,
    averageTitleLength: total > 0 ? todos.reduce((sum, t) => sum + t.title.length, 0) / total : 0,
  });
});

app.get("/api/todos", (req, res) => {
  if (req.query.search) {
    return res.json(findTodosByTitle(req.query.search));
  }
  res.json(todos);
});

app.post("/api/todos", (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return res.status(400).json({ error: "Title is required and must be a non-empty string" });
  }
  const todo = {
    id: nextId++,
    title: title.trim(),
    done: false,
    createdAt: new Date().toISOString(),
  };
  todos.push(todo);
  res.status(201).json(todo);
});

app.patch("/api/todos/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const todo = todos.find((t) => t.id === id);
  if (!todo) {
    return res.status(404).json({ error: "Not found" });
  }
  // Only allow updating known fields
  if (req.body.title !== undefined) todo.title = String(req.body.title).trim();
  if (req.body.done !== undefined) todo.done = Boolean(req.body.done);
  res.json(todo);
});

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

app.get("/api/admin/export", (req, res) => {
  if (!ADMIN_API_KEY) {
    return res.status(503).json({ error: "Admin API key not configured" });
  }
  if (req.headers["x-api-key"] !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ todos, exportedAt: new Date().toISOString() });
});

app.listen(3999, () => {
  console.log("Todo API listening on :3999");
});
