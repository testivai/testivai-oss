/**
 * A small React Native "Orders" screen, rendered on the web by
 * react-native-web (the same library Expo's web target uses). Bundled by
 * e2e/src/rn-web.test.ts with esbuild, `react-native` aliased to
 * `react-native-web`.
 *
 * The query string picks a scripted change:
 *   ?recolor  the Track order button's StyleSheet colour changes
 *   ?retitle  the screen title's text changes
 *   ?banner   a "Daily challenge" banner is inserted above everything
 *
 * Every box has a fixed size, so a change moves things by exact amounts.
 */
import { AppRegistry, Pressable, StyleSheet, Text, View } from 'react-native';

const params = new URLSearchParams(window.location.search);
const banner = params.has('banner');
const recolor = params.has('recolor');
const retitle = params.has('retitle');

const ORDERS = [
  { id: '1042', item: 'Trail shoes', status: 'Shipped' },
  { id: '1043', item: 'Rain jacket', status: 'Packing' },
  { id: '1044', item: 'Water bottle', status: 'Delivered' },
];

function App() {
  return (
    <View style={styles.app}>
      {banner ? (
        <View testID="daily-banner" style={styles.banner}>
          <Text style={styles.bannerText}>Daily challenge</Text>
        </View>
      ) : null}
      <View testID="header" style={styles.header}>
        <Text style={styles.title}>{retitle ? 'My orders' : 'Orders'}</Text>
      </View>
      {ORDERS.map((o) => (
        <View key={o.id} testID={`order-${o.id}`} style={styles.card}>
          <Text style={styles.cardTitle}>{o.item}</Text>
          <Text style={styles.cardStatus}>{`#${o.id} · ${o.status}`}</Text>
        </View>
      ))}
      <Pressable testID="track-order" style={[styles.button, recolor ? styles.buttonAlt : null]}>
        <Text style={styles.buttonText}>Track order</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  app: { width: 360, padding: 16, backgroundColor: '#ffffff' },
  // 56 + 8 = 64 CSS px: a whole number of device pixels at Pixel 7's 2.625.
  banner: { height: 56, marginBottom: 8, backgroundColor: '#ffe08a', justifyContent: 'center', paddingHorizontal: 12 },
  bannerText: { fontSize: 16, color: '#3a2f00' },
  header: { height: 48, marginBottom: 8, backgroundColor: '#20304a', justifyContent: 'center', paddingHorizontal: 12 },
  title: { fontSize: 20, color: '#ffffff' },
  card: { height: 72, marginBottom: 8, borderRadius: 8, backgroundColor: '#f2f4f7', padding: 12 },
  cardTitle: { fontSize: 16, color: '#111111' },
  cardStatus: { fontSize: 14, color: '#555555', marginTop: 4 },
  button: { height: 48, borderRadius: 24, backgroundColor: '#1565c0', alignItems: 'center', justifyContent: 'center' },
  buttonAlt: { backgroundColor: '#c62828' },
  buttonText: { fontSize: 16, color: '#ffffff' },
});

AppRegistry.registerComponent('App', () => App);
AppRegistry.runApplication('App', { rootTag: document.getElementById('root') });
