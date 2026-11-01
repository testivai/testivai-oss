import { StatusBar } from 'expo-status-bar';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

// testID becomes data-testid on the web. With "elementIdAttributes":
// ["data-testid"] in .testivai/config.json, TestivAI names changed elements
// by it (div[data-testid="track-order"]) and keeps their paths stable when
// content is inserted above them.
const ORDERS = [
  { id: '1042', item: 'Trail shoes', status: 'Shipped' },
  { id: '1043', item: 'Rain jacket', status: 'Packing' },
  { id: '1044', item: 'Water bottle', status: 'Delivered' },
];

export default function App() {
  return (
    <ScrollView contentContainerStyle={styles.app}>
      <View testID="header" style={styles.header}>
        <Text style={styles.title}>Orders</Text>
      </View>
      {ORDERS.map((o) => (
        <View key={o.id} testID={`order-${o.id}`} style={styles.card}>
          <Text style={styles.cardTitle}>{o.item}</Text>
          <Text style={styles.cardStatus}>{`#${o.id} · ${o.status}`}</Text>
        </View>
      ))}
      <Pressable testID="track-order" style={styles.button}>
        <Text style={styles.buttonText}>Track order</Text>
      </Pressable>
      <StatusBar style="auto" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  app: { padding: 16, backgroundColor: '#ffffff' },
  header: { height: 48, marginBottom: 8, backgroundColor: '#20304a', justifyContent: 'center', paddingHorizontal: 12 },
  title: { fontSize: 20, color: '#ffffff' },
  card: { height: 72, marginBottom: 8, borderRadius: 8, backgroundColor: '#f2f4f7', padding: 12 },
  cardTitle: { fontSize: 16, color: '#111111' },
  cardStatus: { fontSize: 14, color: '#555555', marginTop: 4 },
  button: { height: 48, borderRadius: 24, backgroundColor: '#1565c0', alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 16, color: '#ffffff' },
});
