@Component
export struct Button {
  @Prop label: string = 'Continue';
  build() { Row() { Text(this.label).fontColor(Color.White) }.padding(12).backgroundColor('#DD6655').borderRadius(10) }
}
