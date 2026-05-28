import { StatusBar } from 'expo-status-bar';
import { useState, useCallback } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import DomComponent from './DomComponent';

// Small payload — known to render on iOS.
const SMALL_ITEMS = [{ id: 1, text: 'Hi.' }];

// Large payload — reliably triggers the iOS WKWebView content-process death.
// ~30 items × ~50 lorem-ipsum repeats ≈ ~30 KB when JSON-serialized into the
// WKWebView initial-props payload.
const LARGE_ITEMS = Array.from({ length: 30 }, (_, i) => ({
  id: i,
  text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(50),
}));

export default function App() {
  const [mode, setMode] = useState(null); // null | 'small' | 'large'
  const [domLogs, setDomLogs] = useState([]);

  const handleDomDebug = useCallback((event, data) => {
    // eslint-disable-next-line no-console
    console.log(`[DOM] ${event}`, data || '');
    setDomLogs((prev) => [
      ...prev,
      `[${new Date().toISOString().slice(11, 23)}] ${event} ${JSON.stringify(
        data,
      )}`,
    ]);
  }, []);

  if (mode === null) {
    return (
      <View style={styles.menu}>
        <Text style={styles.heading}>Expo DOM iOS blank repro</Text>
        <Text style={styles.subheading}>
          Tap one of the buttons below to mount the "use dom" component.
        </Text>
        <View style={{ height: 16 }} />
        <Button
          title="Mount with SMALL payload (1 item) — should render"
          onPress={() => setMode('small')}
        />
        <View style={{ height: 12 }} />
        <Button
          title="Mount with LARGE payload (30 items) — blanks on iOS"
          onPress={() => setMode('large')}
        />
        <View style={{ height: 24 }} />
        <Text style={styles.tip}>
          On iOS the LARGE mount stays visually blank. Metro shows
          "DOM Bundled DomComponent.tsx" followed by [BrowserEngineKit] No such
          process found errors, but never "DOM LOG Running application 'main'"
          and never the [DOM] mount/post-paint logs from this app. The bundle
          ships to the WebView but the content process is killed before it
          can execute.
        </Text>
        <StatusBar style="auto" />
      </View>
    );
  }

  const items = mode === 'small' ? SMALL_ITEMS : LARGE_ITEMS;

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <Button title="← back" onPress={() => setMode(null)} />
        <Text style={styles.toolbarLabel}>
          {mode === 'small' ? 'SMALL payload' : 'LARGE payload'}
          {`  (items=${items.length})`}
        </Text>
      </View>
      <View style={styles.domHost}>
        <DomComponent items={items} onDomDebug={handleDomDebug} />
      </View>
      <View style={styles.logs}>
        <Text style={styles.logsHeading}>RN side — [DOM] logs from inside the WebView:</Text>
        <ScrollView>
          {domLogs.length === 0 ? (
            <Text style={styles.logEmpty}>
              No DOM logs yet. If this stays empty on iOS, the WebView's bundle
              never executed — exactly the bug being reported.
            </Text>
          ) : (
            domLogs.map((line, idx) => (
              <Text key={idx} style={styles.logLine}>{line}</Text>
            ))
          )}
        </ScrollView>
      </View>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  menu: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 80,
    paddingHorizontal: 20,
  },
  heading: { fontSize: 20, fontWeight: '600', marginBottom: 4 },
  subheading: { color: '#555', marginBottom: 8 },
  tip: { fontSize: 12, color: '#666', lineHeight: 18 },
  root: { flex: 1, backgroundColor: '#fff', paddingTop: 50 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ccc',
  },
  toolbarLabel: { marginLeft: 16, fontWeight: '500' },
  domHost: { flex: 1 },
  logs: {
    maxHeight: 200,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ccc',
    paddingHorizontal: 12,
    paddingTop: 8,
    backgroundColor: '#fafafa',
  },
  logsHeading: { fontSize: 11, color: '#888', marginBottom: 4 },
  logEmpty: { fontSize: 11, color: '#c00', fontStyle: 'italic' },
  logLine: { fontSize: 10, fontFamily: 'Menlo', color: '#333' },
});
