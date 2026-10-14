@Entry
@Component
struct Index {
  build() { Column({ space: 12 }) { Text('Piora Design Fixture').fontSize(24).fontWeight(FontWeight.Bold); Text('Generated files compile inside this project.').fontSize(14) }.width('100%').height('100%').justifyContent(FlexAlign.Center).padding(24) }
}
