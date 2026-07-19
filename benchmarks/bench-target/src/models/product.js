// Clean control file — no planted issue.
function buildProductView(product) {
  return { id: product.id, name: product.name, inStock: product.stock > 0 };
}

module.exports = { buildProductView };
