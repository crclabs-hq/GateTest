"use strict";

const express = require("express");
const pg = require("pg");
const router = express.Router();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

router.get("/user/:id", async (req, res) => {
  const id = req.params.id;
  // BAD: user input concatenated directly into SQL — classic injection.
  const q = "SELECT * FROM users WHERE id = " + id;
  const result = await pool.query(q);
  res.json(result.rows);
});

router.get("/search", async (req, res) => {
  const term = req.query.q || "";
  // BAD: template-literal interpolation of unvalidated input.
  const sql = `SELECT * FROM products WHERE name LIKE '%${term}%'`;
  const result = await pool.query(sql);
  res.json(result.rows);
});

module.exports = router;
