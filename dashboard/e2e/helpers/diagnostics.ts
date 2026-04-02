import { ConsoleMessage, Page, Request, TestInfo } from '@playwright/test';

function truncate(value: string, maxLength = 4000) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}... [truncated]`;
}

function formatConsoleEntry(entry: {
  type: string;
  text: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}) {
  const location = entry.url
    ? ` @ ${entry.url}:${entry.lineNumber ?? 0}:${entry.columnNumber ?? 0}`
    : '';

  return `[console.${entry.type}]${location}\n${truncate(entry.text)}`;
}

function formatRequestFailure(request: Request) {
  const failure = request.failure();
  return [
    '[request.failed]',
    `${request.method()} ${request.url()}`,
    failure?.errorText ? `error=${failure.errorText}` : 'error=unknown',
  ].join('\n');
}

export function createPageDiagnosticsCollector(page: Page) {
  const consoleEntries: Array<{
    type: string;
    text: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  }> = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];

  const handleConsole = (message: ConsoleMessage) => {
    const location = message.location();

    consoleEntries.push({
      type: message.type(),
      text: message.text(),
      url: location.url,
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber,
    });
  };

  const handlePageError = (error: Error) => {
    pageErrors.push(error.stack || error.message);
  };

  const handleRequestFailed = (request: Request) => {
    requestFailures.push(formatRequestFailure(request));
  };

  page.on('console', handleConsole);
  page.on('pageerror', handlePageError);
  page.on('requestfailed', handleRequestFailed);

  return {
    async attach(testInfo: TestInfo) {
      page.off('console', handleConsole);
      page.off('pageerror', handlePageError);
      page.off('requestfailed', handleRequestFailed);

      const consoleBody = consoleEntries.length > 0
        ? consoleEntries.map(formatConsoleEntry).join('\n\n')
        : 'No browser console output captured.';

      const pageErrorsBody = pageErrors.length > 0
        ? pageErrors.map((error) => truncate(error)).join('\n\n')
        : 'No page errors captured.';

      const requestFailuresBody = requestFailures.length > 0
        ? requestFailures.join('\n\n')
        : 'No failed network requests captured.';

      await testInfo.attach('browser-console', {
        body: Buffer.from(consoleBody, 'utf8'),
        contentType: 'text/plain',
      });

      await testInfo.attach('browser-page-errors', {
        body: Buffer.from(pageErrorsBody, 'utf8'),
        contentType: 'text/plain',
      });

      await testInfo.attach('browser-request-failures', {
        body: Buffer.from(requestFailuresBody, 'utf8'),
        contentType: 'text/plain',
      });
    },
  };
}