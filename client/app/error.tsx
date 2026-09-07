'use client';

import React from 'react';

export default function ErrorPage() {
  return (
    <div role="alert">
      <h2 className="text-lg font-medium">Could not load this page</h2>
      <p className="mt-2 text-sm text-gray-600">The data is temporarily unavailable.</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-4 rounded bg-gray-900 px-3 py-2 text-sm text-white"
      >
        Try again
      </button>
    </div>
  );
}
