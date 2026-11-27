// Jest runs as CommonJS, where Vite's import.meta.env does not exist.
module.exports = ({ template }) => ({
  visitor: {
    MetaProperty(path) { path.replaceWith(template.expression.ast('({ env: process.env })')); },
  },
});
