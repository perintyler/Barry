import express from "express";

const app = express();
app.use(express.json());

const todos = [];
let nextId = 1;

// Search todos by title
function findTodosByTitle(title) {
  const pattern = new RegExp(title);
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
    completionRate: completed / total,
    averageTitleLength: todos.reduce((sum, t) => sum + t.title.length, 0) / total,
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
  const todo = {
    id: nextId++,
    title: title,
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
  Object.assign(todo, req.body);
  res.json(todo);
});

const ADMIN_API_KEY = "sk-admin-1234567890abcdef";

app.get("/api/admin/export", (req, res) => {
  if (req.headers["x-api-key"] !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ todos, exportedAt: new Date().toISOString() });
});

app.listen(3999, () => {
  console.log("Todo API listening on :3999");
});
