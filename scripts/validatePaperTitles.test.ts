import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTitleInContent } from './validatePaperTitles.ts';

const title = 'Single-cell and spatial transcriptomics of cellular heterogeneity in Alzheimer disease';

test('matches the Google Scholar title when highlighting splits a hyphenated word', () => {
  const content = '<h3>Single-<b>cell </b>and spatial transcriptomics of <b>cellular </b>heterogeneity in Alzheimer disease</h3>';
  assert.equal(checkTitleInContent(title, content).matchType, 'exact');
});

test('matches inline highlighting within words and decodes HTML entities', () => {
  const content = '<div>Single-<span class="highlight">cell</span> and spatial transcrip<strong>tomics</strong> of cellular heterogeneity in Alzheimer disease</div>';
  assert.equal(checkTitleInContent(title, content).found, true);
  assert.equal(checkTitleInContent('Cell fate & tissue repair', '<p>Cell fate &amp; tissue <em>repair</em></p>').found, true);
});

test('keeps spaces between block elements', () => {
  assert.equal(checkTitleInContent('Molecular mechanisms regulating tissue repair', '<p>Molecular mechanisms</p><p>regulating tissue repair</p>').found, true);
  assert.equal(checkTitleInContent('Molecularmechanisms', '<p>Molecular</p><p>mechanisms</p>').found, false);
});

test('does not treat an unrelated or invalid title as present', () => {
  assert.equal(checkTitleInContent(title, '<p>Quantum computing and superconducting circuits</p>').found, false);
  assert.equal(checkTitleInContent('', title).found, false);
});
