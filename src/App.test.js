import { render, screen } from '@testing-library/react';
import App from './App';

beforeAll(() => {
  Object.defineProperty(window.Element.prototype, 'scrollIntoView', {
    writable: true,
    value: jest.fn(),
  });

  Object.defineProperty(navigator, 'mediaDevices', {
    writable: true,
    value: {
      getUserMedia: jest.fn().mockResolvedValue({}),
      enumerateDevices: jest.fn().mockResolvedValue([]),
    },
  });
});

test('renders unsupported browser message when SpeechRecognition is unavailable', () => {
  render(<App />);
  const unsupportedTitle = screen.getByRole('heading', { name: /浏览器不支持/i });
  expect(unsupportedTitle).toBeInTheDocument();
});
