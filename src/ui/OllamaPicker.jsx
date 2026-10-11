import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Field } from './kit.jsx';
import { connectionError, isOllamaEndpoint } from './config.mjs';

export function OllamaPicker({ endpoint, model, onSelect, actor = 'guard' }) {
  const [models, setModels] = useState([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  async function refresh() {
    setLoading(true);
    setError('');
    try {
      if (!window.desktop) throw new Error('Open the desktop app to list your local models.');
      const result = await window.desktop.testModel({ endpoint });
      setModels(result.models);
      if (!result.models.length) setError('No models installed. Add one in Ollama, then refresh.');
    } catch (err) {
      setModels([]);
      setError(connectionError(err, endpoint));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
  }, [endpoint]);
  return (
    <Field
      label="Installed Ollama models"
      hint={error || (models.length ? `${models.length} found · runs locally` : undefined)}
    >
      <span className="select-row">
        <select
          className="select"
          aria-label={`${actor} Ollama model`}
          value={models.includes(model) ? model : ''}
          disabled={loading || !models.length}
          onChange={(e) => onSelect(e.target.value)}
        >
          <option value="">{loading ? 'Finding models…' : 'Choose a model'}</option>
          {models.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-btn"
          aria-label={`Refresh ${actor} Ollama models`}
          title="Refresh"
          disabled={loading}
          onClick={refresh}
        >
          <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </span>
    </Field>
  );
}
