import { Component } from 'react';

const CHUNK_ERROR = /dynamically imported module|module script failed|ChunkLoadError|Unable to preload CSS/i;

/** Handles route chunks that fail to load (offline, or replaced by a new deploy). */
export default class ChunkErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Anything else belongs to the app-level boundary.
    if (!CHUNK_ERROR.test(`${error.name} ${error.message}`)) throw error;
    return (
      <div role="alert" style={{ maxWidth: 500, margin: '4rem auto', padding: '0 1rem', textAlign: 'center' }}>
        <h2>This page could not be loaded</h2>
        <p>Check your connection, or reload to get the latest version.</p>
        {/* A full reload is needed: browsers cache failed module imports. */}
        <button type="button" onClick={() => window.location.reload()}>Reload page</button>
      </div>
    );
  }
}
